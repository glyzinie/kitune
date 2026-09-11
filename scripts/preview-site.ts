const basePath = "/Kitune/";
const production = process.argv.includes("--production");
const directory = new URL(production ? "../site/dist/" : "../site/", import.meta.url);
const sourceFiles = new Set(["index.html", "style.css", "script.js", "favicon.svg"]);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: production ? 4174 : 4173,
  async fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    if (pathname === "/" || pathname === basePath.slice(0, -1)) {
      return new Response(null, { status: 302, headers: { Location: basePath } });
    }
    if (!pathname.startsWith(basePath)) return new Response("Not found", { status: 404 });
    const filename = pathname.slice(basePath.length) || "index.html";
    const allowed = production
      ? filename === "index.html" || /^[\w-]+\.(?:js|css|svg)$/.test(filename)
      : sourceFiles.has(filename);
    if (!allowed) return new Response("Not found", { status: 404 });
    const file = Bun.file(new URL(filename, directory));
    if (!await file.exists()) return new Response("Not found", { status: 404 });
    return new Response(request.method === "HEAD" ? null : file, {
      headers: { "Content-Type": file.type, "Cache-Control": "no-store" },
    });
  },
});

console.log(`Kitune site: http://${server.hostname}:${server.port}${basePath}`);
