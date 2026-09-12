import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { mkdirSync, writeFileSync } from 'node:fs'

// GOOGLEd 应用图标：蓝色渐变圆角方块 + 白云 + 下载箭头（云盘取回）
const SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#5B9BFF"/>
      <stop offset="1" stop-color="#2557D6"/>
    </linearGradient>
    <linearGradient id="arrow" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3B82F6"/>
      <stop offset="1" stop-color="#1D4ED8"/>
    </linearGradient>
  </defs>
  <rect x="16" y="16" width="480" height="480" rx="112" fill="url(#bg)"/>
  <g fill="#FFFFFF">
    <rect x="118" y="298" width="276" height="112" rx="56"/>
    <circle cx="188" cy="282" r="78"/>
    <circle cx="330" cy="264" r="98"/>
  </g>
  <path fill="url(#arrow)" d="M232 176 h48 v118 h62 L256 400 L170 294 h62 Z"/>
  <!-- Google 四色点缀：云下一排小圆点 -->
  <circle cx="196" cy="450" r="14" fill="#4285F4"/>
  <circle cx="236" cy="450" r="14" fill="#EA4335"/>
  <circle cx="276" cy="450" r="14" fill="#FBBC05"/>
  <circle cx="316" cy="450" r="14" fill="#34A853"/>
</svg>
`

const sizes = [16, 24, 32, 48, 64, 128, 256]
mkdirSync('build', { recursive: true })

const pngs = []
for (const s of sizes) {
  const buf = await sharp(Buffer.from(SVG), { density: (72 * s) / 512 })
    .resize(s, s)
    .png()
    .toBuffer()
  pngs.push(buf)
}
const ico = await pngToIco(pngs)
writeFileSync('build/icon.ico', ico)
await sharp(Buffer.from(SVG), { density: 72 }).resize(512, 512).png().toFile('build/icon.png')
console.log('build/icon.ico + build/icon.png 已生成')
