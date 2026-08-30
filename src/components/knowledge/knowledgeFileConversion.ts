/**
 * 文档二进制 -> 纯文本的浏览器侧转换。
 *
 * mammoth / pdfjs-dist 体积较大，全部走动态 import，只有真正打开
 * DOCX / PDF 时才拉取对应 chunk，避免拖慢首屏。
 */

/** DOCX 字节流转纯文本。 */
export async function convertDocxBytesToText(bytes: Uint8Array) {
  const arrayBuffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  const { default: mammoth } = await import("mammoth/mammoth.browser");
  const result = await mammoth.extractRawText({ arrayBuffer });
  return result.value;
}

/**
 * 懒加载 pdf.js 并配好 worker 地址。
 *
 * workerSrc 必须显式指定，否则 pdf.js 会去猜路径，在 Tauri 打包后必然 404。
 */
async function loadPdfJs() {
  const [{ getDocument, GlobalWorkerOptions }, workerModule] = await Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]);
  GlobalWorkerOptions.workerSrc = workerModule.default;
  return { getDocument };
}

/** PDF 字节流逐页抽取文本，页与页之间用空行分隔。 */
export async function convertPdfBytesToText(bytes: Uint8Array) {
  const { getDocument } = await loadPdfJs();
  const loadingTask = getDocument({ data: bytes.slice() });
  const pdf = await loadingTask.promise;
  const parts: string[] = [];

  for (let pageIndex = 1; pageIndex <= pdf.numPages; pageIndex += 1) {
    const page = await pdf.getPage(pageIndex);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item) => {
        if (typeof item === "object" && item && "str" in item) {
          return String((item as { str: string }).str);
        }
        return "";
      })
      .filter(Boolean)
      .join(" ");
    if (pageText.trim()) {
      parts.push(pageText);
    }
  }

  return parts.join("\n\n");
}
