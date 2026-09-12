import { ElMessage } from 'element-plus'

/**
 * 包装任意操作：失败时弹出错误提示。
 * 所有按钮的操作必须经过这里，否则底层请求失败时界面毫无反应（看起来像"没绑定功能"）。
 */
export async function withToast(action: () => Promise<unknown>, failPrefix: string): Promise<void> {
  try {
    await action()
  } catch (e) {
    ElMessage.error(`${failPrefix}：${(e as Error).message}`)
  }
}

/**
 * 把（可能来自 Vue reactive 的）对象转成纯 JSON 数据。
 * 必须在调用 window.api 前 使用：contextBridge 跨世界传参时会先做一次结构化克隆，
 * 任何 Proxy（reactive 对象、被 reactive 包住的数组）都会直接抛 "An object could not be cloned"。
 */
export function plain<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
