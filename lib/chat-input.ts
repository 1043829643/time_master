export type ChatAttempt={id:string;text:string};
export function chatAttemptFor(previous:ChatAttempt|null,text:string,regenerate=false):ChatAttempt{
 const value=text.trim();return !regenerate&&previous?.text===value?previous:{id:crypto.randomUUID(),text:value};
}
