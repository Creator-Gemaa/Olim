import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';

const root = process.cwd();
const svg = await readFile(path.join(root, 'assets', 'logo.svg'));
const png = await sharp(svg).resize(256, 256, { fit: 'contain' }).png().toBuffer();
const output = path.join(root, 'electron');
await mkdir(output, { recursive: true });
const pngPath = path.join(output, 'icon.png');
await writeFile(pngPath, png);
await writeFile(path.join(output, 'icon.ico'), await pngToIco(pngPath));
