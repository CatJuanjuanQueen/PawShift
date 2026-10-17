# PawShift UI

界面相关文件统一放在此文件夹。

| 文件                    | 用途                       |
| ----------------------- | -------------------------- |
| `index.html`            | 界面入口，由桌面程序加载   |
| `app.js`                | 页面、组件、交互与功能图标 |
| `bridge.js`             | 界面与桌面程序的通信       |
| `theme.css`             | 浅色、深色主题与颜色变量   |
| `style.css`             | 布局与组件样式             |
| `brand.svg`             | 小狗头像标识               |
| `dog.svg`               | 坐姿小狗插画               |
| `icon.png` / `icon.ico` | 应用与 Windows 图标        |
| `DESIGN.md`             | 设计说明                   |
| `previews/`             | 界面预览图片，使用示例数据 |

在项目根目录运行 `npm run build` 构建界面，运行 `npm run package:dir` 打包桌面程序。构建会将此处的运行资源复制到 `dist/media/`，保持现有桌面加载路径兼容。`index.html` 需要桌面通信接口，查看效果可先打开 `previews/` 中的图片。

修改 `brand.svg` 后，在项目根目录运行 `node scripts/export-icons.cjs` 重新导出图标。
