import { mergeConfig, type UserConfig } from "vite";

import common from "./vite.common";
import { gameProxy } from "./plugins/game-proxy-plugin";

const config: UserConfig = {
    define: {
        API_URL: JSON.stringify("/api"),
        DEBUG_CLIENT: true
    },
    server: {
        proxy: {
            "/api": {
                target: "http://127.0.0.1:8000",
                changeOrigin: true
            },
            "/team": {
                target: "http://127.0.0.1:8000",
                changeOrigin: true,
                ws: true
            }
        }
    },
    plugins: [gameProxy()]
};

export default mergeConfig(common, config);
