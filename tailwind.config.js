/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // Shroudly brand colors (from logo)
        primary: {
          50: '#E6F0FF',
          100: '#CCE0FF',
          200: '#99C2FF',
          300: '#66A3FF',
          400: '#3B82F6',
          500: '#0052CC',
          600: '#0043A3',
          700: '#00357A',
          800: '#002652',
          900: '#001829',
        },
        dark: {
          50: '#1E293B',
          100: '#1A2332',
          200: '#161D29',
          300: '#121820',
          400: '#0E1218',
          500: '#0A0E1A',
          600: '#080B14',
          700: '#06080E',
          800: '#040508',
          900: '#020203',
        },
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'gradient-conic': 'conic-gradient(from 180deg at 50% 50%, var(--tw-gradient-stops))',
        'shroudly-gradient': 'linear-gradient(135deg, #0052CC 0%, #1E3A8A 50%, #0A0E1A 100%)',
      },
      animation: {
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'spin-slow': 'spin 3s linear infinite',
      },
    },
  },
  plugins: [],
}
