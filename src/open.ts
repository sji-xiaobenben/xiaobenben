/**
 * 用系统默认浏览器打开管理窗口（三平台）。
 * 为什么是浏览器而非原生窗口：exe 壳一期不引 WebView 依赖，管理页自带于 serve 零打包成本；
 * 将来换 WebView2/wkwebview 壳时只需替换此文件。
 */
import { spawn } from "node:child_process";

export function openInBrowser(url: string): void {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
  } catch {
    // 打不开不阻断服务，用户手动访问 127.0.0.1:17630 即可
  }
}
