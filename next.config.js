/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  images: {
    unoptimized: true,
  },
  distDir: 'out',
  trailingSlash: true,
  // Use relative paths for Electron
  assetPrefix: '',
  basePath: '',
}

module.exports = nextConfig
