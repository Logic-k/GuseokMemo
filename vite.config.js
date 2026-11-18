import { defineConfig } from "vite";

export default defineConfig({
  clearScreen: false,
  server: { port: 5183, strictPort: true },
  build: {
    target: "chrome110",
    rollupOptions: {
      input: {
        main: "index.html",
        settings: "settings.html",
        search: "search.html"
      }
    }
  }
});

