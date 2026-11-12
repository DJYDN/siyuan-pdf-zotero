export interface GeneratedArticleMeta {
    summary: string;
    bullets: string[];
    keywords: string[];
    category1: string;
    category2: string;
    category3: string;
    model: string;
    provider: string;
}

export interface GenerateOptions {
    title: string;
    text: string;
    existingPaths: string[];
    maxChars: number;
    modelId?: string;
}

interface ProviderConfig {
    id?: string;
    displayName?: string;
    baseURL: string;
    apiKey?: string;
    authType?: string;
    protocol?: string;
    headers?: Record<string, string>;
    models?: any[];
    enabled?: boolean;
}

interface ProviderModel {
    id: string;
    name: string;
}

function providerModels(provider: ProviderConfig): ProviderModel[] {
    return (provider.models || []).map((item: any) => {
        if (typeof item === "string") return {id: item, name: item};
        const id = String(item?.id || item?.name || item?.model || "");
        const name = String(item?.name || item?.id || item?.model || "");
        return {id, name};
    }).filter(item => item.id || item.name);
}

function selectProvider(configuredModel: string): {provider: ProviderConfig; model: string} {
    const ai = (window as any).siyuan?.config?.ai || {};
    const providers = (Array.isArray(ai.providers) ? ai.providers : [])
        .filter((item: ProviderConfig) => item && item.enabled !== false) as ProviderConfig[];
    if (!providers.length) {
        throw new Error("思源尚未配置 AI provider");
    }
    const selected = String(configuredModel || ai.agent?.modelId || ai.editing?.modelId || "").trim();
    let provider: ProviderConfig | undefined;
    let model: ProviderModel | undefined;
    if (selected) {
        for (const candidate of providers) {
            const found = providerModels(candidate).find(item => item.id === selected || item.name === selected);
            if (found) {
                provider = candidate;
                model = found;
                break;
            }
        }
    }
    if (!provider) {
        provider = providers.find(item => providerModels(item).length > 0) || providers[0];
        model = providerModels(provider)[0];
    }
    if (!provider || !model) {
        throw new Error("AI provider 没有可用模型");
    }
    // `models[].name` is what the provider API expects (`deepseek-flash`),
    // while `models[].id` is only SiYuan's internal picker id.
    return {provider, model: model.name};
}

function providerHeaders(provider: ProviderConfig): Record<string, string> {
    const headers: Record<string, string> = {"Content-Type": "application/json"};
    if (provider.headers && typeof provider.headers === "object") {
        for (const [key, value] of Object.entries(provider.headers)) {
            headers[key] = String(value);
        }
    }
    if (provider.authType === "chatgpt" && !provider.apiKey) {
        throw new Error("ChatGPT 账号登录型 provider 无法直接作为 API 使用");
    }
    if (provider.apiKey) {
        if ((provider.protocol || "openai") === "anthropic") {
            headers["x-api-key"] = provider.apiKey;
            headers["anthropic-version"] = headers["anthropic-version"] || "2023-06-01";
        } else {
            headers.Authorization = `Bearer ${provider.apiKey}`;
        }
    }
    return headers;
}

function url(baseURL: string, path: string): string {
    return `${baseURL.replace(/\/+$/, "")}${path}`;
}

async function postJson(urlValue: string, headers: Record<string, string>, body: unknown): Promise<any> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 120_000);
    try {
        const response = await fetch(urlValue, {
            method: "POST",
            headers,
            body: JSON.stringify(body),
            signal: controller.signal,
        });
        const text = await response.text();
        if (!response.ok) {
            throw new Error(`AI HTTP ${response.status}: ${text.slice(0, 300)}`);
        }
        try {
            return JSON.parse(text);
        } catch {
            return {__text: text};
        }
    } finally {
        window.clearTimeout(timer);
    }
}

function responseText(protocol: string, data: any): string {
    if (protocol === "anthropic") {
        return (data?.content || []).map((item: any) => item?.text || "").join("\n");
    }
    if (protocol === "openai-responses") {
        if (typeof data?.output_text === "string") return data.output_text;
        return (data?.output || []).flatMap((item: any) => item?.content || [])
            .map((item: any) => item?.text || "").join("\n");
    }
    return data?.choices?.[0]?.message?.content
        || data?.choices?.[0]?.text
        || data?.__text
        || "";
}

function cleanFences(text: string): string {
    return text.replace(/```(?:json)?/gi, "").trim();
}

function parseJsonObject(text: string): any | null {
    const cleaned = cleanFences(text);
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
        return null;
    }
}

function stringArray(value: any): string[] {
    if (Array.isArray(value)) {
        return value.map(item => String(item || "").trim()).filter(Boolean);
    }
    if (typeof value === "string" && value.trim()) {
        return value.split(/[、,，;；\n]/).map(item => item.trim()).filter(Boolean);
    }
    return [];
}

function clamp(meta: GeneratedArticleMeta, maxChars: number): GeneratedArticleMeta {
    const limit = Math.max(120, Number(maxChars) || 450);
    let summary = String(meta.summary || "").replace(/\s+/g, " ").trim();
    let bullets = meta.bullets.map(item => String(item || "").replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 6);
    let keywords = meta.keywords.map(item => String(item || "").trim()).filter(Boolean).slice(0, 10);
    const size = () => summary.length + bullets.join("").length + keywords.join("").length;
    if (size() > limit) {
        const overflow = size() - limit;
        summary = summary.length > overflow + 80 ? summary.slice(0, summary.length - overflow) : summary.slice(0, 80);
    }
    if (size() > limit) {
        while (bullets.length && size() > limit) bullets = bullets.slice(0, -1);
    }
    if (size() > limit) {
        keywords = keywords.slice(0, Math.max(1, keywords.length - 2));
    }
    return {...meta, summary, bullets, keywords};
}

function buildPrompt(options: GenerateOptions, existingPaths: string[]): string {
    const paths = existingPaths.filter(Boolean).slice(-80).join("\n") || "（暂无）";
    return [
        "你是中文技术/学术文章摘要助手。请只输出一个 JSON 对象，不要 markdown 代码块。",
        "",
        "JSON 格式：",
        '{"summary":"一段摘要","bullets":["要点1","要点2"],"keywords":["关键词1"],"category1":"一级分类","category2":"二级分类","category3":"三级分类"}',
        "",
        "要求：",
        `1. summary 用中文写一段 100–220 字的总述；`,
        `2. bullets 写 3–5 条要点，每条不超过 40 字；`,
        `3. keywords 提取 3–8 个关键词或标签；`,
        `4. 摘要正文 + 要点 + 关键词合计不超过 ${Math.max(120, Number(options.maxChars) || 450)} 字；`,
        "5. 三级分类采用动态分类：优先复用下面已有路径；确实不匹配时才新增；",
        "6. category1/2/3 不能为空；",
        "7. 不要编造文章中没有的信息。",
        "",
        "已有分类路径：",
        paths,
        "",
        `文章标题：${options.title}`,
        "",
        "文章正文（可能截断）：",
        options.text.slice(0, 16_000),
    ].join("\n");
}

export async function chatWithSiyuanAI(
    messages: Array<{role: "system" | "user" | "assistant"; content: string}>,
    modelId = "",
): Promise<string> {
    const {provider, model} = selectProvider(modelId);
    const protocol = String(provider.protocol || "openai");
    const headers = providerHeaders(provider);
    const system = messages.find(item => item.role === "system")?.content || "";
    const chatMessages = messages.filter(item => item.role !== "system");
    let data: any;
    if (protocol === "anthropic") {
        data = await postJson(url(provider.baseURL, "/messages"), headers, {
            model,
            max_tokens: 2400,
            temperature: 0.2,
            system,
            messages: chatMessages.map(item => ({role: item.role, content: item.content})),
        });
    } else if (protocol === "openai-responses") {
        data = await postJson(url(provider.baseURL, "/responses"), headers, {
            model,
            input: [
                ...(system ? [{role: "system", content: [{type: "input_text", text: system}]}] : []),
                ...chatMessages.map(item => ({role: item.role, content: [{type: "input_text", text: item.content}]})),
            ],
            temperature: 0.2,
            max_output_tokens: 2400,
        });
    } else {
        data = await postJson(url(provider.baseURL, "/chat/completions"), headers, {
            model,
            messages,
            temperature: 0.2,
            max_tokens: 2400,
        });
    }
    const text = responseText(protocol, data).trim();
    if (!text) throw new Error("AI 返回空内容");
    return text;
}

export async function chatWithSiyuanAIStream(
    messages: Array<{role: "system" | "user" | "assistant"; content: string}>,
    modelId: string,
    onDelta: (delta: string, full: string) => void,
): Promise<string> {
    const {provider, model} = selectProvider(modelId);
    const protocol = String(provider.protocol || "openai");
    const headers = providerHeaders(provider);
    const system = messages.find(item => item.role === "system")?.content || "";
    const chatMessages = messages.filter(item => item.role !== "system");
    let endpoint = url(provider.baseURL, "/chat/completions");
    let body: Record<string, any>;
    if (protocol === "anthropic") {
        endpoint = url(provider.baseURL, "/messages");
        body = {model, max_tokens: 2400, temperature: 0.2, system, stream: true, messages: chatMessages};
    } else if (protocol === "openai-responses") {
        endpoint = url(provider.baseURL, "/responses");
        body = {
            model,
            stream: true,
            input: [
                ...(system ? [{role: "system", content: [{type: "input_text", text: system}]}] : []),
                ...chatMessages.map(item => ({role: item.role, content: [{type: "input_text", text: item.content}]})),
            ],
            temperature: 0.2,
            max_output_tokens: 2400,
        };
    } else {
        body = {model, stream: true, messages, temperature: 0.2, max_tokens: 2400};
    }
    const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
    });
    if (!response.ok || !response.body) {
        const text = await response.text().catch(() => "");
        throw new Error(`AI HTTP ${response.status}: ${text.slice(0, 300)}`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    const consume = (payload: string) => {
        if (payload === "[DONE]") return;
        let data: any;
        try {
            data = JSON.parse(payload);
        } catch {
            return;
        }
        let delta = "";
        if (protocol === "anthropic") {
            if (data?.type === "content_block_delta") delta = String(data?.delta?.text || "");
        } else if (protocol === "openai-responses") {
            if (data?.type === "response.output_text.delta") delta = String(data?.delta || "");
            else if (data?.type === "response.content_part.delta") delta = String(data?.delta?.text || "");
        } else {
            delta = String(data?.choices?.[0]?.delta?.content || "");
        }
        if (delta) {
            full += delta;
            onDelta(delta, full);
        }
    };
    while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, {stream: true});
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
            const event = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            for (const line of event.split(/\r?\n/)) {
                if (!line.startsWith("data:")) continue;
                consume(line.slice(5).trim());
            }
            boundary = buffer.indexOf("\n\n");
        }
    }
    if (buffer.trim()) {
        for (const line of buffer.split(/\r?\n/)) {
            if (line.startsWith("data:")) consume(line.slice(5).trim());
        }
    }
    if (!full.trim()) {
        // Some OpenAI-compatible gateways ignore stream:true and return a
        // normal JSON response. Keep the UI feeling live by revealing the
        // completed answer in small chunks instead of one final block.
        const fallback = await chatWithSiyuanAI(messages, modelId);
        const chunks = fallback.match(/[\s\S]{1,24}/g) || [fallback];
        let visible = "";
        for (const chunk of chunks) {
            visible += chunk;
            onDelta(chunk, visible);
            await new Promise(resolve => window.setTimeout(resolve, 18));
        }
        return fallback;
    }
    return full;
}

export async function generateArticleMeta(options: GenerateOptions): Promise<GeneratedArticleMeta> {
    const {provider, model} = selectProvider(options.modelId || "");
    const protocol = String(provider.protocol || "openai");
    const headers = providerHeaders(provider);
    const prompt = buildPrompt(options, options.existingPaths);

    let data: any;
    if (protocol === "anthropic") {
        data = await postJson(url(provider.baseURL, "/messages"), headers, {
            model,
            max_tokens: 1800,
            temperature: 0.2,
            messages: [{role: "user", content: prompt}],
        });
    } else if (protocol === "openai-responses") {
        data = await postJson(url(provider.baseURL, "/responses"), headers, {
            model,
            input: [{role: "user", content: [{type: "input_text", text: prompt}]}],
            temperature: 0.2,
            max_output_tokens: 1800,
        });
    } else {
        data = await postJson(url(provider.baseURL, "/chat/completions"), headers, {
            model,
            messages: [{role: "user", content: prompt}],
            temperature: 0.2,
            max_tokens: 1800,
        });
    }

    const raw = responseText(protocol, data).trim();
    if (!raw) {
        throw new Error("AI 返回空内容");
    }
    const parsed = parseJsonObject(raw) || {};
    const category = parsed.category || {};
    const meta: GeneratedArticleMeta = {
        summary: String(parsed.summary || raw).trim(),
        bullets: stringArray(parsed.bullets || parsed.points),
        keywords: stringArray(parsed.keywords || parsed.tags),
        category1: String(parsed.category1 || category.level1 || "未分类").trim(),
        category2: String(parsed.category2 || category.level2 || "未分类").trim(),
        category3: String(parsed.category3 || category.level3 || "未分类").trim(),
        model,
        provider: String(provider.displayName || provider.id || "AI"),
    };
    return clamp(meta, options.maxChars);
}
