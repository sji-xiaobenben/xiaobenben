/**
 * 编译期资产嵌入（Bun 的 `with { type: "file" }`）的类型声明。
 *
 * 这类 import 在运行时拿到的是**路径字符串**（dev 下是真实磁盘路径，编译产物里是 bunfs 路径），
 * 不是图像/二进制对象 —— 与 `tray-assets.ts` 的用法一致。
 *
 * 刻意通配到具体形态（`*.png` / `systray2/traybin/*`）而不是写 `declare module "*"`：
 * 后者会让**任何**拼错的模块名都静默变成 `any`，等于把类型检查关掉一半。
 */
declare module "*.png" {
  const path: string;
  export default path;
}

declare module "*.ico" {
  const path: string;
  export default path;
}

declare module "systray2/traybin/*" {
  const path: string;
  export default path;
}
