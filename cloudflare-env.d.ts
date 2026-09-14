declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    QWEN_API_KEY?: string;
    QWEN_CHAT_MODEL?: string;
    QWEN_ASR_MODEL?: string;
    QWEN_TTS_MODEL?: string;
    QWEN_ACCESS_MODE?: string;
    QWEN_VOICE?: string;
    BUCKET?: R2Bucket;
  }
}
