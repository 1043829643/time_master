declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    QWEN_API_KEY?: string;
    QWEN_CHAT_MODEL?: string;
    QWEN_ASR_MODEL?: string;
    QWEN_TTS_MODEL?: string;
    QWEN_ACCESS_MODE?: string;
    QWEN_VOICE?: string;
    QWEN_REALTIME_WORKSPACE_ID?: string;
    QWEN_REALTIME_API_KEY?: string;
    QWEN_REALTIME_MODEL?: string;
    QWEN_REALTIME_TEST_MODE?: string;
    BUCKET?: R2Bucket;
  }
}
