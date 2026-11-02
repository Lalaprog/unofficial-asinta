/** @type {import('tailwindcss').Config} */
module.exports = {
  // NOTE: `darkMode: ["class"]` was removed here. It was never implemented —
  // there are zero `dark:` utilities in the codebase — so it advertised a
  // theme that did not exist. Re-add it together with real dark styling.
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    extend: {
      colors: {
        navy: {
          DEFAULT: '#0B1F3A',
          deep: '#142B4A',
          light: '#1B3B66',
          muted: '#244778',
          subtle: '#3A5E94',
        },
        brand: {
          DEFAULT: '#1E4D78',
          deep: '#223748',
          graphite: '#3F3F3F',
          steel: '#A5A5A5',
        },
        surface: {
          DEFAULT: '#F7F9FC',
          card: '#FFFFFF',
          elevated: '#FFFFFF',
          inset: '#F1F4F8',
          border: '#E1E6ED',
          borderHover: '#C9D2DE',
        },
        // Contrast-corrected to meet WCAG AA (4.5:1) on white, surface
        // (#F7F9FC) and inset (#F1F4F8) backgrounds:
        //   secondary #4E5A6B → 7.00 / 6.64 / 6.35
        //   muted     #5A6474 → 5.98 / 5.67 / 5.42
        // The previous muted (#8F9AA8) measured 2.85:1 on white and was used
        // 60+ times, often on 10–11px text.
        ink: {
          primary: '#172033',
          secondary: '#4E5A6B',
          muted: '#5A6474',
          inverted: '#FFFFFF',
        },
        status: {
          success: '#0D7A53',
          'success-bg': '#E8F6F0',
          // 4.95:1 against warning-bg; white on this token is 5.38:1.
          warning: '#A85308',
          'warning-bg': '#FEF4E8',
          danger: '#C52828',
          'danger-bg': '#FDECEC',
          info: '#205898',
          'info-bg': '#EEF4FC',
        }
      },
      fontFamily: {
        sans: [
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'BlinkMacSystemFont',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
        mono: [
          'JetBrains Mono',
          'SFMono-Regular',
          'Menlo',
          'Monaco',
          'Consolas',
          'monospace',
        ],
      },
      boxShadow: {
        'neu-raised': '0 1px 3px rgba(11, 31, 58, 0.05)',
        'neu-raised-sm': '0 1px 2px rgba(11, 31, 58, 0.04)',
        'neu-raised-lg': '0 8px 24px rgba(11, 31, 58, 0.08)',
        'neu-inset': 'inset 0 1px 2px rgba(11, 31, 58, 0.04)',
        'neu-inset-sm': 'inset 0 1px 1px rgba(11, 31, 58, 0.035)',
        'neu-pressed': 'inset 0 1px 2px rgba(11, 31, 58, 0.08)',
        'navy-glow': '0 4px 12px rgba(11, 31, 58, 0.12)',
      },
      borderRadius: {
        'architectural': '12px',
        'architectural-sm': '8px',
        'architectural-lg': '18px',
        'architectural-xl': '24px',
      },
    },
  },
  plugins: [],
};
