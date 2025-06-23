const SUBPATH = "/arte-antica";
let data = [];
let currentIndex = -1;
const seen = [];
const image = document.getElementById("image");
const text = document.getElementById("text");
const overlay = document.getElementById("overlay");
const pdfviewer = document.getElementById("pdfviewer");

fetch("data.json")
  .then(res => res.json())
  .then(json => {
    data = shuffle(json);
    nextImage();
  });

function shuffle(arr) {
  return arr.slice().sort(() => Math.random() - 0.5);
}

function nextImage() {
  if (seen.length >= data.length) return;
  currentIndex++;
  const entry = data[seen.length];
  seen.push(entry);
  image.src = entry.src;
  text.textContent = entry.text || "";
  text.style.display = "none";
}

function prevImage() {
  if (currentIndex <= 0) return;
  currentIndex--;
  const entry = seen[currentIndex];
  image.src = entry.src;
  text.textContent = entry.text || "";
  text.style.display = "none";
}

function showTextAndPDF() {
  if (currentIndex < 0) return;
  const entry = seen[currentIndex];
  text.style.display = "block";
  if (entry.fileName && entry.page) {
    const encodedPdf = encodeURIComponent(`${SUBPATH}/${SUBPATH}/pdfs/${entry.fileName}`);
    const url = `${SUBPATH}/${SUBPATH}/pdfjs/web/viewer.html?file=${encodedPdf}#page=${entry.page}`;
    pdfviewer.src = url;
    overlay.style.display = "block";
  }
}

function closeOverlay() {
  overlay.style.display = "none";
  pdfviewer.src = "";
}

image.onclick = showTextAndPDF;

document.addEventListener("keydown", (e) => {
  if (e.key === "s" || e.key === "S") showTextAndPDF();
  else if (e.key === "ArrowRight") nextImage();
  else if (e.key === "ArrowLeft") prevImage();
  else if (e.key === "Escape") closeOverlay();
});
