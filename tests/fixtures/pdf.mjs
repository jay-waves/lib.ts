export function samplePdf(width = 595, height = 842) {
  const content = 'BT /F1 14 Tf 24 48 Td (PDF Preview - crisp text 0123456789) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(content)} >>
stream
${content}
endstream`,
  ];
  return pdfFromObjects(objects);
}

function pdfFromObjects(objects) {
  let output = `%PDF-1.4
`;
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj
${body}
endobj
`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref
0 ${offsets.length}
0000000000 65535 f 
`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n 
`;
  return `${output}trailer
<< /Size ${offsets.length} /Root 1 0 R >>
startxref
${xref}
%%EOF
`;
}

// Two differently sized pages, a rotated first page, nested Unicode outlines,
// both /Dest and /A GoTo targets, and an external link that is not a page jump.
export function outlinedPdf() {
  return pdfFromObjects([
    '<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Rotate 90 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] >>',
    '<< /Type /Outlines /First 6 0 R /Last 8 0 R /Count 3 >>',
    '<< /Title (Chapter) /Parent 5 0 R /Dest [3 0 R /Fit] /First 7 0 R /Last 7 0 R /Next 8 0 R /Count 1 >>',
    '<< /Title <FEFF4E2D6587> /Parent 6 0 R /A << /S /GoTo /D [4 0 R /Fit] >> >>',
    '<< /Title (Website) /Parent 5 0 R /Prev 6 0 R /A << /S /URI /URI (https://example.com) >> >>',
  ]);
}
