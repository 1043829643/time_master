# 时间管理大师

温润极简的个人工作空间：项目全景、并行事项、日程、推进看板、联系人、工程位置，以及 Qwen 语音助理。

## 代码管理

项目仓库：[1043829643/time_master](https://github.com/1043829643/time_master)，主分支为 `main`。Git 仅保存源码、配置模板与测试；密钥、本机数据库、依赖和构建产物均通过 `.gitignore` 排除。

## 运行

需要 Node.js 22.13+。安装依赖后执行 npm run dev。使用 React / Vinext、Cloudflare Worker 与 D1；生产数据按登录用户隔离。首次本地使用先生成并应用 drizzle/ 中的数据库迁移，持久目录为 .wrangler/state。

## Qwen 配置

线上服务使用北京地域的百炼通用 API Key。本机交互测试支持 Token Plan 专用接口：QWEN_ACCESS_MODE=token-plan-local；此模式在生产构建中禁用。

在忽略的 .dev.vars 中配置与 .env.example 一致的变量：QWEN_API_KEY、QWEN_CHAT_MODEL、QWEN_ASR_MODEL、QWEN_TTS_MODEL。托管环境使用 Sites secret，不要把凭证写入源码或浏览器。

通用接口默认模型：qwen-plus（对话与安排方案）、qwen3-asr-flash（语音识别）、qwen3-tts-flash（中文朗读）。本机 Token Plan 测试使用 qwen3.8-flash、qwen-audio-3.0-asr-flash、qwen-audio-3.0-tts-plus，音色 longanhuan_v3.6。浏览器录音在本机转为 16kHz 单声道 WAV 后提交。识别文本可编辑，安排方案需要检查后应用；没有密钥时明确显示未配置。

## 数据行为

- 任务周期允许并行；只有具体日程时段检查冲突。
- 事项超出项目周期时，项目日期自动扩展。
- 保存使用版本比较；旧页面不能覆盖新数据。发生冲突时保留输入，需关闭编辑、刷新并核对后重新打开。
- 删除事项或项目会解除依赖、移除未完成日程，已完成日程保留为独立记录。实际电脑文件和共享联系人不删除。
- 工程路径和微信号为上下文记录，不会自动访问本地文件或发送消息。
- 示例由用户主动载入；托管站点首次进入为空工作空间。本地测试数据不上传。

## 验证

npm run build
node --experimental-strip-types --test tests/domain.test.mjs

测试记录见 tests/verification.md。现有 Token Plan 密钥已完成本机真实语音识别、方案生成、日程保存和语音播放。本站线上环境未配置该套餐密钥。
