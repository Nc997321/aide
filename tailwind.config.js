/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{vue,js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        bg: {
          primary: '#1e1e2e',
          secondary: '#181825',
          tertiary: '#11111b',
        },
        surface: {
          DEFAULT: '#313244',
          hover: '#45475a',
          active: '#585b70',
        },
        text: {
          primary: '#cdd6f4',
          secondary: '#a6adc8',
          muted: '#6c7086',
        },
        accent: {
          DEFAULT: '#89b4fa',
          green: '#a6e3a1',
          yellow: '#f9e2af',
          red: '#f38ba8',
          purple: '#cba6f7',
        },
      },
    },
  },
  plugins: [],
}
