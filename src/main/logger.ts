import { app } from 'electron'
import * as fs from 'node:fs'
import * as path from 'node:path'

const LOG_DIR = () => path.join(app.getPath('userData'), 'logs')

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function write(level: string, args: unknown[]): void {
  const line = `[${new Date().toISOString()}] [${level}] ${args
    .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ')}\n`
  try {
    const dir = LOG_DIR()
    fs.mkdirSync(dir, { recursive: true })
    fs.appendFileSync(path.join(dir, `app-${today()}.log`), line)
  } catch {
    /* 日志失败不影响主流程 */
  }
  if (level === 'ERROR') console.error(line.trim())
  else console.log(line.trim())
}

export const logger = {
  info: (...args: unknown[]) => write('INFO', args),
  warn: (...args: unknown[]) => write('WARN', args),
  error: (...args: unknown[]) => write('ERROR', args)
}
