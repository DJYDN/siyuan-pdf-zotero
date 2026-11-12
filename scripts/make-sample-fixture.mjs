#!/usr/bin/env node
/**
 * Generate a small, synthetic two-page PDF used by the integration tests.
 * This avoids shipping third-party paper content in the repository.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const output = path.join(root, "test-fixtures", "sample-paper.pdf");
const escapeText = value => value.replaceAll("\\", "\\\\").replaceAll("(", "\\(").replaceAll(")", "\\)");

function content(page) {
    const lines = [];
    for (let index = 0; index < 130; index++) {
        const text = index === 4
            ? "Poly(vinyl chloride) (PVC) is a synthetic polymer used for actuator tests."
            : `Synthetic test content line ${String(index + 1).padStart(3, "0")} for PDF.js extraction.`;
        lines.push(`BT /F1 8 Tf 40 ${780 - index * 5.5} Td (${escapeText(text)}) Tj ET`);
    }
    lines.push(`BT /F1 10 Tf 40 20 Td (Synthetic page ${page}) Tj ET`);
    return lines.join("\n");
}

const streams = [1, 2].map(page => content(page));
const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R 6 0 R] /Count 2 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${Buffer.byteLength(streams[0])} >>\nstream\n${streams[0]}\nendstream`,
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents 7 0 R >>",
    `<< /Length ${Buffer.byteLength(streams[1])} >>\nstream\n${streams[1]}\nendstream`,
];
let pdf = "%PDF-1.4\n%\u00e2\u00e3\u00cf\u00d3\n";
const offsets = [0];
for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
}
const xrefOffset = Buffer.byteLength(pdf, "latin1");
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

fs.mkdirSync(path.dirname(output), {recursive: true});
fs.writeFileSync(output, Buffer.from(pdf, "latin1"));
console.log(`[fixtures] wrote ${output} (${fs.statSync(output).size} bytes)`);
