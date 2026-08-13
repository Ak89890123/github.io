# Interactive Resume

Lazydoooog 的互動式履歷網站。使用 Vite、vanilla JavaScript、GSAP ScrollTrigger 與 Three.js 製作；影片、角色與畫面覆層皆由瀏覽器依捲動進度控制。

## 開始使用

```bash
npm install
npm run dev
```

正式驗證：

```bash
npm test
npm run build
```

## 專案結構

```text
src/                    網站程式、動畫控制器與測試
public/assets/          正式網站圖片、影片、sprites 與 posters
index.html              Vite 入口
package.json            開發、測試與建置指令
.github/workflows/      GitHub Pages 自動部署
```

這個公開分支不收錄 Agent 指令、研究與決策文件、工作票、瀏覽器截圖、建置輸出、原始大型媒體或影片生成工程。

## 頁面與動畫

- Hero：48 fps 影片捲動控制，結尾接 Three.js 紙張撕裂轉場。
- About：三螢幕工作室與滑板狗 DOM／sprite 動畫。
- Skills：噴漆牆與可讀的 HTML 技能內容。
- Experience：連續路徑與履歷節點。
- Contact：滑板狗、蟑螂與手機的可逆捲動交接。
- 小於 768px 或 `prefers-reduced-motion` 時使用靜態、可讀的替代呈現。

## 媒體規則

- 網站影片放在 `public/assets/videos/`。
- 對應 poster 放在 `public/assets/posters/`。
- sprites、背景與材質分別放在 `public/assets/sprites/`、`backgrounds/`、`textures/`。
- 可讀文字只放在 HTML，不放進影片或 Canvas。
- 新媒體加入後，同步更新 `src/animation-map.json` 與相關測試。

## 部署

```bash
npm run build
```

部署 `dist/` 到任何靜態網站服務即可。正式部署前必須確認 `npm test` 與 `npm run build` 均通過。
