# 使用验证记录

验证时间：2026-09-14。浏览器为本机 Edge，无真实用户信息参与测试。

| 范围 | 结果 |
| --- | --- |
| 领域规则自动测试 | 12/12 通过；包括并行、同名、部分更新、循环依赖、删除关联、日期、幂等与冲突 |
| TypeScript 静态检查 | 通过 |
| 生产构建 | 通过 |
| 本地 D1：真实 API | 新增 200；相同操作重试不增加版本；同版本并发返回 200/409；无效批次 400 且数据不变 |
| 请求边界 | 非同源请求 403；无效音频 400；缺少通用密钥时明确 503 |
| 浏览器操作 | 项目/事项创建、悬停详情、刷新保留、日程添加与完成、看板拖动、联系人、工程路径均通过 |
| 表单失败恢复 | 起止日期无效时保留输入，显示原因 |
| 手机布局 | 390×844 检查，文档宽度 390；时间轴在自身容器内滚动 |
| 桌面布局 | 1512×1000 检查，共享时间轴、条内简称、并行分层与依赖显示正常 |
| 模拟麦克风 | 录音转 16kHz WAV 后进入识别请求；模拟返回可编辑文字；停止/取消后所有媒体轨道 ended |
| 模拟 Agent 回复 | 展示待应用方案，用户应用后真实写入本地 D1 日程 |
| WebMCP | 浏览器原生上下文不可用；用注册器测试替身验证两个工具及无效输入处理，不等同原生兼容性验证 |

## 已完成的本机真实 Qwen 联测

本次由用户在 Codex 内手动发起交互测试，使用现有 Token Plan 密钥及官方套餐专用域名。此前将套餐使用限制扩大为“不能做任何测试”的判断已纠正。本机采用 token-plan-local 模式，未上传套餐密钥到托管环境；生产构建禁用该模式。

| 真实调用 | 证据 |
| --- | --- |
| qwen3.8-flash 文本连接 | HTTP 200，回复“连接成功”，用量 46 tokens |
| qwen-audio-3.0-tts-plus 合成 | HTTP 200，生成 4.72 秒、24kHz 单声道 WAV；音色 longanhuan_v3.6 |
| qwen-audio-3.0-asr-flash 识别 | HTTP 200，正确识别“明天上午10点到11点，安排时间管理大师的语音测试。” |
| 浏览器录音转换与真实 ASR | 使用上述语音作为模拟麦克风输入，通过网页录音、WAV 转换和实际供应商请求，识别正确 |
| 真实 Agent 方案 | qwen3.8-flash 生成明天 10:00–11:00 的独立测试日程，通过校验并显示方案 |
| 应用方案 | 用户交互点击应用后实际写入本地 D1；日程视图正确显示 |
| 真实 Qwen 朗读 | /api/qwen/tts 返回 200，HTMLAudioElement.play 成功，出现停止朗读按钮，停止成功 |

联测发现并修复：Cloudflare fetch 不支持 redirect:error，改为 manual 并检查 HTTP 状态；Token Plan 的 TTS 使用独立 SpeechSynthesizer 路径，ASR 使用 DashScope 多模态路径并读取 output.text。已有通用接口保留。

限制：测试音频来自 Qwen 合成，不是用户本人麦克风录制；没有测试实时 WebSocket 连续对话。网页当前采用录音→识别→编辑发送→方案应用→朗读的分段交互。单次测试的延迟和音质不代表长期性能。

官方依据：
- https://help.aliyun.com/zh/model-studio/token-plan-personal-overview
- https://help.aliyun.com/zh/model-studio/token-plan-multimodal-gen
- https://help.aliyun.com/zh/model-studio/non-realtime-speech-recognition-user-guide