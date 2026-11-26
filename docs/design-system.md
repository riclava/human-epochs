# 界面设计系统

本规范适用于浅色 Web 界面。按变量的语义角色选用颜色、字号和间距，同一角色的取值统一维护。文末的 CSS 变量可直接复制使用。

## 颜色

| 用途 | 变量 | 用法 |
| --- | --- | --- |
| 页面与层次 | `--color-canvas`、`--color-sidebar`、`--color-panel`、`--color-subtle` | 分别用于页面、侧栏、面板及次级区域的底色 |
| 文字 | `--color-ink`、`--color-muted` | 分别用于主要内容和辅助说明 |
| 操作与选择 | `--color-accent`、`--color-accent-hover`、`--color-on-accent`、`--color-accent-soft`、`--color-selected` | 主按钮使用强调底色与反白文字，悬停时加深底色。浅强调色用于轻量交互反馈，选中项同时用底色、字重或位置标记区分。链接保留下划线等可辨识线索 |
| 边界与焦点 | `--color-border`、`--color-control-border`、`--color-focus` | 细线分隔内容，输入框使用更深的边界，键盘焦点使用独立且可见的轮廓 |
| 错误与禁用 | `--color-error`、`--color-error-soft`、`--color-disabled`、`--color-disabled-ink` | 错误色与浅底搭配，并提供纠正说明。禁用控件使用专用底色和文字色，必要时说明原因或下一步 |
| 位置与封面 | `--color-marker`、`--color-cover`、`--color-cover-ink`、`--color-cover-detail` | 位置标记用于当前项或阅读位置。封面使用专用的背景、文字和装饰色 |

正文和辅助文字在各自底色上的对比度目标至少为 4.5∶1，输入框边界和焦点轮廓与相邻背景至少为 3∶1。改变底色时一起检查其上的文字、链接和焦点。浏览器强制颜色模式下仍应能通过轮廓和文字读出状态。

## 字体与尺度

| 角色 | 变量 | 用法 |
| --- | --- | --- |
| 品牌与封面 | `--font-brand`、`--font-display`、`--text-display` | 品牌字标和封面标题均复用界面无衬线字体，封面标题随视口缩放 |
| 页面与章节 | `--text-title`、`--text-section` | 分别用于页面标题和章节标题，HTML 标题层级按内容结构排列 |
| 正文与控件 | `--font-ui`、`--text-body`、`--text-small` | 正文使用 `--text-body`，标签和较紧凑的操作文字可用 `--text-small` |
| 辅助信息与标识 | `--text-caption`、`--font-mono` | 说明文字用 `--text-caption`，代码和技术标识用等宽字体。需要对齐或频繁更新的数字使用 `tabular-nums` |

正文、标题和品牌共用一个无衬线字体栈，字体不可用时按声明顺序回退。标题层级通过字号、字重和间距体现。行高使用无单位数值，正文可取 1.5 至 1.6。用 `rem` 让字号随浏览器的字号设置缩放。窄屏允许长标题、引文和连续的技术标识换行，保留全文。

## 间距与形状

间距以 `0.25rem` 为基本单位。图标与标签之间通常取 `--space-2`，组件内边距取 `--space-3` 到 `--space-6`，段落组之间取 `--section-gap`。连续阅读区的最大宽度由 `--reading-width` 控制，窄屏保留两侧留白。

按钮和输入框默认使用 `--control-height`（2.75rem）。设置表单等密集界面在宽屏、精细指针操作时可使用 `--control-height-compact`（2.5rem），窄屏和以触控为主的设备使用默认尺寸。触控输入文字至少为 1rem。短数字字段按最大位数和步进控件所需空间定宽，按钮按文字与内边距定宽。

控件圆角取 `--radius-control`。卡片的圆角取 `--radius-card`，外层面板取 `--radius-panel`。面板需要强调层次时可使用 `--shadow-panel`。

## 组件与状态

| 组件 | 使用约定 |
| --- | --- |
| 按钮与链接 | 用按钮执行操作，用链接前往目的地。使用原生元素并提供可访问名称，纯图标按钮也需有能描述动作的名称。键盘操作可达且焦点可见。 |
| 表单 | 每个字段保留可见标签。字段错误通过 `aria-describedby` 关联到对应字段，并用 `aria-invalid` 标明无效状态。提交中显示当前动作，可恢复的提交失败提供重试。 |
| 导航 | 当前页面链接同时具有可见选中样式和 `aria-current="page"`。窄屏导航的展开按钮使用 `aria-expanded`，高度至少为 `--control-height`。焦点在展开区域内时可用 Escape 收起，并将焦点还给按钮。 |
| 消息与引用 | 消息按阅读顺序排列，发言者可辨识。输入区提供可访问名称和可见的发送操作，启用键盘快捷键时在操作附近说明。引文与出处相邻呈现，窄屏可读到全文。 |
| 加载、空状态与错误 | 在受影响的区域说明正在执行的动作、结果或可用的下一步。异步状态与错误应能被辅助技术感知，可恢复的错误在原位置提供重试。 |

## 学习内容呈现

组件按已发布的形式和顺序呈现 AI 选出的内容，沿用现有字号、阅读宽度和控件规范。窄屏和可访问视图使用相同的公开数据，引文可选择和复制，数值与时间使用等宽数字。引用或资源加载失败时，在原位置显示状态，保留当前焦点和阅读位置。各类型的可选组件、窄屏与可访问呈现见[学习内容呈现技术设计](content-presentation.md#内容类型与呈现)。

## 界面验收

- 覆盖 `320px` 窄屏、桌面、低高度横屏和文字放大至 200% 的场景，确认内容可读、控件可用，长文本可换行或展开阅读。
- 用键盘走一遍主要操作，核对焦点顺序、焦点样式，以及关闭可展开区域后的焦点位置。
- 检查默认、悬停、聚焦、选中、加载、错误和禁用等适用状态，确认重要反馈可以通过文字、形状或辅助技术感知。

## CSS 变量

```css
:root {
  color-scheme: light;
  --color-canvas: #eef3f8;
  --color-panel: #ffffff;
  --color-sidebar: var(--color-panel);
  --color-subtle: #f5f8fc;
  --color-ink: #19283b;
  --color-muted: #536478;
  --color-accent: #244fc2;
  --color-accent-hover: #193d9c;
  --color-accent-soft: #eaf0ff;
  --color-selected: #dce7ff;
  --color-on-accent: #ffffff;
  --color-border: #c4d0df;
  --color-control-border: #747e8a;
  --color-focus: #005fcc;
  --color-error: #9d332e;
  --color-error-soft: #fff0ed;
  --color-disabled: #e1e7ef;
  --color-disabled-ink: #576678;
  --color-marker: var(--color-accent);
  --color-cover: var(--color-accent);
  --color-cover-ink: var(--color-on-accent);
  --color-cover-detail: #c4d7ff;

  --font-ui: Inter, "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", system-ui, sans-serif;
  --font-display: var(--font-ui);
  --font-brand: var(--font-ui);
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;
  --text-caption: .8125rem;
  --text-small: .9375rem;
  --text-body: 1rem;
  --text-section: clamp(1.125rem, 1rem + .5vw, 1.375rem);
  --text-title: clamp(1.75rem, 1.3rem + 2vw, 2.5rem);
  --text-display: clamp(2.25rem, 1.65rem + 3.3vw, 3.75rem);

  --space-1: .25rem;
  --space-2: .5rem;
  --space-3: .75rem;
  --space-4: 1rem;
  --space-5: 1.25rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --space-10: 2.5rem;
  --space-12: 3rem;
  --section-gap: clamp(1.5rem, 1rem + 2vw, 3rem);
  --reading-width: 48rem;
  --control-height: 2.75rem;
  --control-height-compact: 2.5rem;
  --radius-control: .375rem;
  --radius-card: .625rem;
  --radius-panel: .875rem;
  --shadow-panel: 0 2px 6px rgb(25 40 59 / 6%);
}
```
