// 把 messages 里的 content 归一成纯文本 —— 所有适配器共用
// ===========================================================================
// 存在的唯一原因是一个真实 P0（黑盒测试发现）：
//
//   OpenAI SDK 与 Responses API 会把 content 传成**分片数组**
//     `[{ type: "text", text: "..." }, { type: "image_url", ... }]`
//   而多个适配器直接用 `String(m.content)` 取文本 —— JS 会把每个对象
//   转成 `"[object Object]"`，于是模型真正收到的是
//     `[object Object],[object Object]`
//   （实测：请求带一张图时，上游 body 里的 text 就是这个字符串）。
//
// 后果非常隐蔽：模型收到垃圾文本却照常回答、照常计费；用户看到"模型答非所问"，
// 而日志里存的 prompt 是**正确的**（网关在适配器之前就记了），
// 排查时会以为模型疯了或以为自己看错了。
//
// 所以：**任何要取 content 文本的地方都必须走这里，不要写 String(content)**。
// 图片片一律返回空串 —— 图片由各适配器的 injectImages / imageContent 单独追加，
// 在这里也返回的话同一张图会被加两次。
export function normalizeContentToText(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        if (part.type === "text") return String(part.text ?? part.content ?? "");
        // image_url / image 片交给适配器单独拼，避免重复
        return "";
      })
      .join("");
  }
  if (typeof content === "object") return String(content.text ?? "");
  return String(content);
}

export default normalizeContentToText;
