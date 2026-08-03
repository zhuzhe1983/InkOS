# InkOS 服务端渲染版式预览

统一使用 `m5stack-paper-s3-portrait`、540×960 竖屏、默认字号生成。每张图都是服务端渲染器输出的第一页，图片素材使用确定性的本地灰度占位图，便于离线重复生成和比较排版。

总览：[layout-overview.png](./layout-overview.png)

| layout | 分类 | 用途 | 总页数 | 预览 |
| --- | --- | --- | ---: | --- |
| `grid` | 核心版式 | 规则网格 / 月历 | 1 | [01-grid.png](./01-grid.png) |
| `reader` | 核心版式 | 无标题沉浸阅读 | 2 | [02-reader.png](./02-reader.png) |
| `list` | 核心版式 | 线性菜单 / 时间线 | 1 | [03-list.png](./03-list.png) |
| `postcard` | 核心版式 | 单张视觉信息卡 | 1 | [04-postcard.png](./04-postcard.png) |
| `cardboard` | 核心版式 | 多卡片状态看板 | 1 | [05-cardboard.png](./05-cardboard.png) |
| `article` | 兼容版式 | 图文文章详情 | 3 | [06-article.png](./06-article.png) |
| `image-story` | 兼容版式 | 图片主导的故事 | 3 | [07-image-story.png](./07-image-story.png) |
| `feed` | 兼容版式 | 资讯流列表 | 2 | [08-feed.png](./08-feed.png) |
| `masonry` | 兼容版式 | 瀑布流图库 | 1 | [09-masonry.png](./09-masonry.png) |
| `bookshelf` | 兼容版式 | 电子书架 | 1 | [10-bookshelf.png](./10-bookshelf.png) |
| `contain` | 兼容版式 | 完整适配图片 | 1 | [11-contain.png](./11-contain.png) |
| `cover` | 兼容版式 | 满屏裁剪图片 | 1 | [12-cover.png](./12-cover.png) |

重新生成：

```bash
cd server
npx tsx scripts/capture-layout-previews.ts
```
