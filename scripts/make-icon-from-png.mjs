import sharp from 'sharp'
import pngToIco from 'png-to-ico'
import { mkdirSync, writeFileSync } from 'node:fs'

// 从 AI 生成的候选图裁出图标方块 → 圆角透明蒙版 → 多尺寸 ico
const SRC = 'build/icon-src/cand1.png'
const CROP = { left: 204, top: 201, width: 620, height: 620 }
const RADIUS = 138

const mask = Buffer.from(
  `<svg width="${CROP.width}" height="${CROP.height}"><rect x="0" y="0" width="${CROP.width}" height="${CROP.height}" rx="${RADIUS}" ry="${RADIUS}"/></svg>`
)

const base = await sharp(SRC)
  .extract(CROP)
  .composite([{ input: mask, blend: 'dest-in' }])
  .png()
  .toBuffer()

const sizes = [16, 24, 32, 48, 64, 128, 256]
mkdirSync('build', { recursive: true })
const pngs = []
for (const s of sizes) {
  pngs.push(await sharp(base).resize(s, s).png().toBuffer())
}
const ico = await pngToIco(pngs)
writeFileSync('build/icon.ico', ico)
await sharp(base).resize(512, 512).png().toFile('build/icon.png')
console.log('build/icon.ico + build/icon.png 已生成（AI 图标版）')
