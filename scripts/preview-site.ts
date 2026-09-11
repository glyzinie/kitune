const basePath = "/Kitune/";
const files = new Map([
  ["", "index.html"],
  ["index.html", "index.html"],
  ["style.css", "style.css"],
  ["script.js", "script.js"],
  ["favicon.svg", "favicon.svg"],
]);

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 4173,
  fetch(request) {
    const { pathname } = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
    }
    if (pathname === "/" || pathname === basePath.slice(0, -1)) {
      return new Response(null, { status: 302, headers: { Location: basePath } });
    }
    const filename = pathname.startsWith(basePath) ? files.get(pathname.slice(basePath.length)) : undefined;
    if (!filename) return new Response("Not found", { status: 404 });
    const file = Bun.file(new URL(`../site/${filename}`, import.meta.url));
    return new Response(request.method === "HEAD" ? null : file, {
      headers: { "Content-Type": file.type, "Cache-Control": "no-store" },
    });
  },
});

console.log(`Kitune site: http://${server.hostname}:${server.port}${basePath}`);
