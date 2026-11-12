declare module "katex" {
    interface KatexOptions {
        displayMode?: boolean;
        throwOnError?: boolean;
        strict?: boolean | string;
    }
    const katex: {
        renderToString(expression: string, options?: KatexOptions): string;
    };
    export default katex;
}
