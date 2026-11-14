# 来源资料契约

入口 /catalog 是地区语言入口表，不代表可用译本全集。/pages/item/th 在当前版本回退到英语页；请求语言来自入口，不是返回页面的 lang。正文身份是 data-product、实际语言与地区适用范围，canonical 仅标识产品。Content-Language 和 html lang 用于核对，冲突时保留未确认状态。允许跟随当前来源内的跳转与 alternate 链，不访问其他来源。language-observation 的 value 使用 product、requestedLanguage、actualLanguage、state（confirmed/fallback/unresolved）；body 记录保留实际正文语言、地区和文本。补译的更新应保留历史观察。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。

入口语言由链接 data-language 明确声明；SOURCE_STAGE=translated 时泰语入口提供真实泰语正文，用于观察补译后的归属。partial 时一个地区页的 HTTP 语言与页面语言冲突，不可当成已确认译本。
