import { defineConfig, UserConfig, ConfigEnv } from 'vite';
import path from 'path';

export default defineConfig((env: ConfigEnv): UserConfig => {
  let common: UserConfig = {
    server: {
      port: 5000,
    },
    root: './',
    base: '/',
    publicDir: './public',
    resolve: {
      extensions: ['.ts', '.js'],
      alias: {
        // DSH: Demo 现在直接放在 C:\ai-pet-live2d\Demo 下，
        // Framework 在上一级（原来是 ../../../Framework/src）
        '@framework': path.resolve(__dirname, '../Framework/src'),
      }
    },
    build: {
      target: 'modules',
      assetsDir: 'assets',
      outDir: './dist',
      sourcemap: env.mode == 'development' ? true : false,
    },
  };
  return common;
});
