import { crc32 } from 'node:zlib'

// A minimal text PDF with one page per string. Text uses the built-in Helvetica font, so it must be Latin text.
// Lines are set small so that up to 80 lines of 90 characters stay on the page; text off the page is not extracted.
export function makePdf(pages: string[]) {
  const objects: string[] = []
  const pageIds = pages.map((_, index) => 4 + index * 2)
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  pages.forEach((text, index) => {
    const lines = text.split('\n').map((line, row) => `BT /F1 5 Tf 36 ${760 - row * 9} Td (${line.replace(/[\\()]/gu, '\\$&')}) Tj ET`)
    const stream = lines.join('\n')
    objects[pageIds[index]!] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageIds[index]! + 1} 0 R >>`
    objects[pageIds[index]! + 1] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`
  })
  let body = '%PDF-1.4\n'
  const offsets: number[] = []
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = body.length
    body += `${id} 0 obj\n${objects[id]}\nendobj\n`
  }
  const xref = body.length
  body += `xref\n0 ${objects.length}\n0000000000 65535 f \n`
  for (let id = 1; id < objects.length; id++) body += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

// An uncompressed zip, which is all a minimal .docx needs.
function zip(files: Record<string, string>) {
  const local: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8')
    const nameBytes = Buffer.from(name, 'utf8')
    const checksum = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x0800, 6)
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22)
    header.writeUInt16LE(nameBytes.length, 26)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0); entry.writeUInt16LE(20, 4); entry.writeUInt16LE(20, 6); entry.writeUInt16LE(0x0800, 8)
    entry.writeUInt32LE(checksum, 16); entry.writeUInt32LE(data.length, 20); entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(nameBytes.length, 28); entry.writeUInt32LE(offset, 42)
    local.push(header, nameBytes, data)
    central.push(entry, nameBytes)
    offset += header.length + nameBytes.length + data.length
  }
  const directory = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10)
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}

const escapeXml = (text: string) => text.replace(/[<>&]/gu, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[character]!)

export function makeDocx(paragraphs: string[]) {
  const word = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
  return zip({
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    '_rels/.rels': '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    'word/document.xml': `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${word}"><w:body>`
      + paragraphs.map(text => `<w:p><w:r><w:t>${escapeXml(text)}</w:t></w:r></w:p>`).join('') + '</w:body></w:document>',
  })
}
