import fs from "fs/promises";
import path from "path";
import sharp from "sharp";
import { fileURLToPath } from "url";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import deepmerge from "deepmerge";
import slugify from "slugify";

const PAGES_MAX = 100000000000;
const PAGES_PER_SLICE = 10000000;
const BREAK_BETWEEN_SLICE = 1000;

type Manifest = { src: string; fileName: string; page: number; text: string }[];

type FilePath = string & { _: string };

type PageLogs = {
  lastElIdx: number;
  attemptsOnPage: number;
  completed: boolean;
};

type FileLogs = {
  lastPage: number;
  completed: boolean;
  pages: Record<number, PageLogs>;
};

type Logs = {
  inputDir: string;
  files: Record<FilePath, FileLogs>;
  completed: boolean;
};

const { getDocument, GlobalWorkerOptions, OPS, ImageKind } = pdfjsLib;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const INPUT_DIR = path.join(__dirname, "..", "input");
const OUTPUT_IMG_DIR = path.join(__dirname, "..", "public", "images");
const OUTPUT_MANIFEST = path.join(__dirname, "..", "public", "data.json");
const OUTPUT_LOGS = path.join(__dirname, "..", "public", "logs.json");

GlobalWorkerOptions.workerSrc = new URL(
  "../node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

/* ---------- utility ------------------------------------------------------ */

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const dist = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1]);

const near = (box: number[], item: any, thr = 100) => {
  const cx1 = (box[0] + box[2]) / 2,
    cy1 = (box[1] + box[3]) / 2;
  const cx2 = item.transform[4] || 0,
    cy2 = item.transform[5] || 0;
  return dist([cx1, cy1], [cx2, cy2]) < thr;
};

const listPdfsPaths = async (dir: string): Promise<FilePath[]> => {
  const ents = await fs.readdir(dir, { withFileTypes: true });
  const all = await Promise.all(
    ents.map((e) =>
      e.isDirectory()
        ? listPdfsPaths(path.resolve(dir, e.name))
        : [path.resolve(dir, e.name)]
    )
  );
  return (all as FilePath[][])
    .flat()
    .filter((f) => f.toLowerCase().endsWith(".pdf"));
};

async function compressImage(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize({ width: 1200, height: 1080, fit: "inside" })
    .jpeg({ quality: 80 })
    .toBuffer();
}

function markLastIdxInFile({
  pdfPath,
  logs,
  pageIdx,
  elIdx,
}: {
  pdfPath: FilePath;
  logs: Logs;
  pageIdx: number;
  elIdx: number;
}) {
  logs.files[pdfPath].pages[pageIdx].lastElIdx = elIdx;
}

/* ---------- image extraction -------------------------------------------- */

async function extractImages({
  pdfPath,
  manifest,
  logs,
}: {
  pdfPath: FilePath;
  manifest: Manifest;
  logs: Logs;
}) {
  const data = new Uint8Array(await fs.readFile(pdfPath));
  const doc = await getDocument({ data }).promise;

  const totalPages = Math.min(PAGES_MAX, doc.numPages);
  // const pagesPerSlice = Math.min(PAGES_PER_SLICE, doc.numPages);
  // const slices = Math.ceil(Math.max(1, doc.numPages / pagesPerSlice));

  // for (
  //   let slice = 0;
  //   slice < Array.from(Array(slices).keys()).length;
  //   slice++
  // ) {
  const initialPage = logs.files[pdfPath].lastPage
    ? logs.files[pdfPath].lastPage + 1
    : 1;
  // const initialPage = logs.files[pdfPath].lastPage + 1 /*  + slice */ || 1;
  const lastPage = totalPages;
  // const lastPage =
  //   initialPage + Math.min(initialPage + pagesPerSlice, totalPages);

  for (let pageIdx = initialPage; pageIdx <= lastPage; pageIdx++) {
    logs.files[pdfPath].pages = logs.files[pdfPath].pages || {};
    logs.files[pdfPath].pages[pageIdx] =
      logs.files[pdfPath].pages[pageIdx] || {};

    logs.files[pdfPath].pages[pageIdx].attemptsOnPage =
      (logs.files[pdfPath].pages[pageIdx].attemptsOnPage || 0) + 1;

    await fs.writeFile(OUTPUT_LOGS, JSON.stringify(logs, null, 2));

    if (logs.files[pdfPath].pages[pageIdx].attemptsOnPage > 2) {
      continue;
    }

    const initialIdx = logs.files[pdfPath].pages[pageIdx].lastElIdx || 0;
    const page = await doc.getPage(pageIdx);
    const ops = await page.getOperatorList();
    const txt = await page.getTextContent();
    const elementsQuantity = ops.fnArray.length;
    const pdfSlug = slugify(path.basename(pdfPath), {
      lower: true,
      strict: true,
      trim: true,
    });

    for (let elIdx = initialIdx; elIdx < elementsQuantity; elIdx++) {
      const fn = ops.fnArray[elIdx];
      if (
        fn !== OPS.paintImageXObject &&
        fn !== OPS.paintXObject /*  && fn !== OPS.paintJpegXObject */
      ) {
        markLastIdxInFile({ pdfPath, logs, pageIdx, elIdx });
        continue;
      }

      // console.log("🚀 ~ pageIdx:", pageIdx, elIdx);

      const [name, tr] = ops.argsArray[elIdx]; // name, transform
      const img: any = await new Promise((res) => page.objs.get(name, res));

      if (!img || !img.data) {
        console.warn("⚠️  image skipped – empty data");
        markLastIdxInFile({ pdfPath, logs, pageIdx, elIdx });
        continue;
      }

      /* ---------- obtain usable Buffer ---------------------------------- */
      let buffer: Buffer | undefined = undefined;

      // quick test: already JPEG?
      const isJPEG = img.data[0] === 0xff && img.data[1] === 0xd8;
      if (isJPEG) {
        console.log("isJPEG:", isJPEG);
        buffer = Buffer.from(img.data); // pass straight to sharp
      } else {
        // decode raw → jpeg via sharp
        const ch =
          img.kind === ImageKind.RGBA_32BPP
            ? 4
            : img.kind === ImageKind.GRAYSCALE_1BPP
            ? 1
            : 3;

        let sharpRes: sharp.Sharp | null = null;

        try {
          // console.log("try to get buffer");
          // const canvas = createCanvas(img.width, img.height);
          // const context = canvas.getContext("2d");
          // const viewport = page.getViewport();

          // // @ts-expect-error
          // await page.render({ canvasContext: context, viewport }).promise;
          // buffer = canvas.toBuffer("image/jpeg");

          sharpRes = await sharp(Buffer.from(img.data), {
            raw: { width: img.width, height: img.height, channels: ch },
          }).jpeg();
        } catch (e: any) {
          console.warn(`⚠️  sharpRes failed (${e.message}); skipping image`);
          // buffer = null;
        }

        try {
          const resBuffer = await sharpRes?.toBuffer({
            resolveWithObject: true,
          });
          buffer = resBuffer?.data;
          // console.log("buffer info:", resBuffer?.info);
        } catch (e: any) {
          console.warn(`⚠️  resBuffer failed (${e.message}); skipping image`);
          // buffer = null;
        }
      }

      if (!buffer) {
        markLastIdxInFile({ pdfPath, logs, pageIdx, elIdx });
        continue;
      }

      /* ---------- bounding box + nearby text ---------------------------- */
      const [x, y] = [tr[4], tr[5]];
      const box = [x, y, x + tr[0], y + tr[3]];
      const localText = txt.items
        .filter((it: any) => near(box, it))
        .map((it: any) => it.str)
        .join(" ");

      const fname = `${pdfSlug}-img__p${pageIdx}--n${elIdx}.jpg`;
      const compressed = await compressImage(buffer);

      try {
        await fs.writeFile(path.join(OUTPUT_IMG_DIR, fname), compressed);
        console.log(
          `written image ${elIdx} p. ${pageIdx}/${totalPages}: ${fname} (doc: ${pdfPath})`
        );
      } catch (_e) {}

      markLastIdxInFile({ pdfPath, logs, pageIdx, elIdx });
      manifest.push({
        src: `images/${fname}`,
        text: localText,
        fileName: path.basename(pdfPath),
        page: pageIdx,
      });

      await fs.writeFile(OUTPUT_MANIFEST, JSON.stringify(manifest, null, 2));
      await fs.writeFile(OUTPUT_LOGS, JSON.stringify(logs, null, 2));
      // if (elIdx >= elementsQuantity) {
      //   logs.files[pdfPath].lastPage = pageIdx;
      // }
    }

    logs.files[pdfPath].lastPage = pageIdx;
    // }

    // await sleep(BREAK_BETWEEN_SLICE);
  }

  // logs.files[pdfPath].completed = true;
}

async function getInitialManifest() {
  const defaults: Manifest = [];

  try {
    const stored = await fs.readFile(OUTPUT_MANIFEST, { encoding: "utf-8" });
    const json = JSON.parse(stored);
    return deepmerge(defaults, json);
  } catch (_e) {}

  return defaults;
}

async function getInitialLogs() {
  const defaults: Logs = {
    inputDir: INPUT_DIR,
    files: {},
    completed: false,
  };

  try {
    const stored = await fs.readFile(OUTPUT_LOGS, { encoding: "utf-8" });
    const json = JSON.parse(stored);
    return deepmerge(defaults, json);
  } catch (_e) {}

  return defaults;
}

async function run() {
  const manifest = await getInitialManifest();
  const logs = await getInitialLogs();

  if (logs.completed) return;

  for (const pdfPath of await listPdfsPaths(INPUT_DIR)) {
    // console.log("📄", path.basename(pdfPath));
    if (!logs.files[pdfPath]) {
      logs.files[pdfPath] = {
        completed: false,
        pages: {},
        lastPage: 0,
      };
    }

    if (!logs.files[pdfPath].completed) {
      await extractImages({ pdfPath, manifest, logs });
    }
  }

  // console.log(`✅ ${manifest.length} images extracted and data.json written`);

  // if (!logs.completed) {
  //   await run();
  // }
}

/* ---------- main -------------------------------------------------------- */

(async () => {
  await fs.mkdir(OUTPUT_IMG_DIR, { recursive: true });

  await run();
})().catch(console.error);
