# 来源资料契约

入口 /catalog 是地区语言入口表，不代表可用译本全集。/pages/item/th 在当前版本回退到英语页；请求语言来自入口，不是返回页面的 lang。正文身份是 data-product、实际语言与地区适用范围，canonical 仅标识产品。Content-Language 和 html lang 用于核对，冲突时保留未确认状态。允许跟随当前来源内的跳转与 alternate 链，不访问其他来源。language-observation 的 value 使用 product、requestedLanguage、actualLanguage、state（confirmed/fallback/unresolved）；body 记录保留实际正文语言、地区和文本。补译的更新应保留历史观察。

收件服务对该契约的解释口径：

- 请求语言（requestedLanguage）只取自入口链接的 data-language；实际正文语言（actualLanguage）取自落地页 html lang，并与 HTTP Content-Language 交叉核对。两者不一致即 unresolved，不猜、不降级成 confirmed。
- state 判定：实际语言与请求语言一致为 confirmed；落地页是另一种语言（含跳转后）为 fallback；信号冲突、缺少 data-product 或入口无法领取为 unresolved，并在 issues 登记原因与范围。未核实入口不等于来源删除。
- 地区限定（region）由请求语言标签的地区子标签给出（如 zh-HK → HK），与实际语言分开存储。
- canonical 仅作为页面声明原样记录在观察值中，不参与记录键、不作为跨语言合并键；记录键是产品加请求语言，因此同一 canonical 下各语言各自独立。alternate 链同样只记录声明，不自动合并。
- 每次跳转手动跟随并逐跳留痕（状态码、from、to），写入收件 trace 与观察 provenance；跳转只允许在冻结的同源 origin 内，超过五跳或成环按来源错误处理。
- 站点补发某语言后重跑采集：该语言的当前观察与正文被替换，旧值转入 language-observation-history / product-body-history 并附 supersededAt；其他语言的已确认记录键不同，不会被改写。来源未变化的重跑保持幂等，不产生历史记录。
- product-body 按产品加实际语言登记正文文本；回退得到的英文正文只登记为英文，不会标记成请求的泰文。

每条已解释资料均可回到真实来源收件和具体位置。原始载荷与版本必须继续可查，不能以解析后的摘要替代原文。未列出的标准扩展允许明确标识未支持，不允许假称已解释。

入口语言由链接 data-language 明确声明；SOURCE_STAGE=translated 时泰语入口提供真实泰语正文，用于观察补译后的归属。partial 时一个地区页的 HTTP 语言与页面语言冲突，不可当成已确认译本。
