import http from "http";
import handler from "serve-handler";

export async function startStaticServer(
  rootPath
) {
  return new Promise((resolve, reject) => {

    const server = http.createServer(
      (req, res) => {
        return handler(req, res, {
          public: rootPath,
          // V-43: serve files literally. serve-handler defaults to cleanUrls
          // (rewriting /about.html -> /about, with a 301), which breaks internal
          // links and behavior checks that reference real filenames.
          cleanUrls: false,
          trailingSlash: false,
          directoryListing: false
        });
      }
    );

    // V-36: bind to loopback only — the student site must not be reachable
    // on the network during evaluation.
    server.listen(0, "127.0.0.1", () => {

      const port =
        server.address().port;

      resolve({
        server,
        url:
          `http://127.0.0.1:${port}`
      });
    });

    server.on(
      "error",
      reject
    );
  });
}