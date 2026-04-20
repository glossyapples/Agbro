/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#effef7',
          100: '#d9fdeb',
          200: '#b5f9d7',
          300: '#80f2bc',
          400: '#44e39c',
          500: '#1fcb82',
          600: '#12a66a',
          700: '#118258',
          800: '#136748',
          900: '#12553d',
        },
        ink: {
          50: '#f7f8fa',
          100: '#eef0f4',
          200: '#dde1ea',
          300: '#bfc6d4',
          400: '#8993a6',
          500: '#5d6678',
          600: '#404859',
          700: '#2d3443',
          800: '#1b2030',
          900: '#10131c',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'sans-serif'],
      },
    },
  },
  plugins: [],
};
