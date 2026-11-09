import { defineConfig } from "vite";

// 싱글스레드 web-ifc만 사용한다. COOP/COEP 헤더를 켜면 web-ifc가 멀티스레드 wasm(web-ifc-mt.wasm)을 먼저 찾는다.
export default defineConfig({
  optimizeDeps: { exclude: ["web-ifc"] },
  build: { target: "es2022", chunkSizeWarningLimit: 5000 },
});
