/**
 * Orbix default design tokens.
 *
 * Ported 1:1 from the Claude Design system
 * (`_ds/orbix-design-system-74bb2898.../tokens/*.css`). The source uses `oklch()`,
 * which React Native cannot parse, so each value was gamut-mapped to sRGB by
 * reducing chroma until it fit (the same algorithm browsers apply) rather than
 * clamping channels, which would have oversaturated the out-of-gamut reds.
 *
 * The `oklch(...)` original is kept in a trailing comment for every colour so
 * the mapping stays auditable against the prototype.
 */
import type {
  OrbixTheme,
  ThemeColors,
  ThemeGradients,
  ThemeRadius,
  ThemeShadows,
  ThemeSpacing,
  ThemeTypography,
} from './types';

/* ── Raw palette ─────────────────────────────────────────────────────────── */

export const palette = {
  brandBlue50: '#eef6ff', // oklch(0.97 0.02 250)
  brandBlue100: '#d7eaff', // oklch(0.93 0.04 250)
  brandBlue300: '#85bcf5', // oklch(0.78 0.10 250)
  brandBlue500: '#006bb9', // oklch(0.52 0.18 250)
  brandBlue600: '#005a9d', // oklch(0.46 0.18 250)
  brandBlue700: '#004479', // oklch(0.38 0.16 250)
  brandTeal400: '#00d9d1', // oklch(0.80 0.14 190)

  neutral0: '#ffffff', // oklch(1 0 0)
  neutral50: '#f3f5f8', // oklch(0.97 0.005 250)
  neutral100: '#f0f2f4', // oklch(0.96 0.004 250)
  neutral200: '#dfe1e4', // oklch(0.91 0.005 250)
  neutral400: '#9a9fa5', // oklch(0.70 0.01 250)
  neutral500: '#6d7277', // oklch(0.55 0.01 250)
  neutral900: '#080c0f', // oklch(0.15 0.01 250)

  /** Prototype-local accents that drive `--grad-primary`. */
  accentPurple: '#00627F',// '#a439c9', // oklch(0.56 0.22 316)
  accentPink: '#045A70',// '#ed5c9e', // oklch(0.68 0.19 355)

  secondaryLight: '#e8f3ff', // oklch(0.96 0.04 250)
  destructiveLight: '#e40016', // oklch(0.577 0.245 27.325)

  /**
   * Paradas del degradado `wash`, en orden. Se nombran por posición y no por
   * tono a propósito: son lo primero que se recolorea, y unos nombres de color
   * quedan mintiendo en cuanto la paleta cambia.
   */
  /** Paradas de `productTile`, de arriba a abajo. */
  productTileTop: '#FDFFFF',
  productTileBottom: '#E3F9FF',

  /** `productTile` en oscuro — plano, no comparte tono con `darkCard`. */
  darkProductTile: '#2B2B2D',

  washStart: '#DDF0F7',
  washMid: '#E8F3F6',
  washEnd: '#ECF3F3',

  /**
   * Paradas del degradado `wash` en oscuro, en el mismo orden que las claras.
   * Gris neutro puro (sin tinte azul/cian) de arriba a abajo, para calzar con
   * la referencia de diseño — arranca en un gris medio y cae a casi negro,
   * quedando por debajo de `darkCard` en luminosidad en toda su extensión
   * para que las tarjetas sigan levantándose del fondo.
   */
  darkWashStart: '#3a3a3d', // oklch(0.30 0 0)
  darkWashMid: '#1c1c1e', // oklch(0.18 0 0)
  darkWashEnd: '#0a0a0b', // oklch(0.10 0 0)

  /** Dark scheme. */
  darkBackground: '#040609', // oklch(0.12 0.01 250)
  darkForeground: '#eceff2', // oklch(0.95 0.005 250)
  darkCard: '#2B2B2B',
  darkPrimary: '#0f92f7', // oklch(0.65 0.18 250)
  darkSecondary: '#011b35', // oklch(0.22 0.06 250)
  darkMuted: '#15191d', // oklch(0.21 0.01 250)
  /**
   * Etiquetas, placeholders y texto secundario en oscuro. El anterior daba
   * 4.18:1 sobre el fondo y 2.92:1 sobre la superficie de un input: por debajo
   * de 4.5:1 en ambos, asi que las etiquetas y sobre todo los placeholders se
   * leian a medias. Este da 6.70:1 y 4.68:1, y conserva el escalon con
   * `darkForeground` para que siga siendo texto secundario.
   */
  // Se aparta del prototipo (era #6d7277, oklch(0.45 0.01 250)) por contraste.
  darkMutedForeground: '#8f959b',
  /**
   * Borde de inputs y tarjetas en oscuro. El anterior quedaba a 1.30:1 del
   * fondo: el campo solo se distinguia por su relleno y un input vacio casi
   * desaparecia. Sube a 2.03:1, suficiente para que el contorno exista sin
   * convertirse en la linea gris pesada que delata un tema oscuro mal hecho.
   */
  // Se aparta del prototipo (era #202429, oklch(0.26 0.01 250)) por contraste.
  darkBorder: '#3d434a',
  darkDestructive: '#ff6568', // oklch(0.704 0.191 22.216)

  /** Splash canvas — literal in the prototype (`#0a0e1a`). */
  splashNavy: '#0a0e1a',

  /** Semantic pairs — already hex in the source token file. */
  greenBg: '#dcfce7',
  greenFg: '#166534',
  yellowBg: '#fef9c3',
  yellowFg: '#854d0e',
  redBg: '#fee2e2',
  redFg: '#991b1b',
  blueBg: '#dbeafe',
  blueFg: '#1e40af',
  grayBg: '#f3f4f6',
  grayFg: '#6b7280',
} as const;

/* ── Colour roles ────────────────────────────────────────────────────────── */

const brandRamp = {
  brandBlue50: palette.brandBlue50,
  brandBlue100: palette.brandBlue100,
  brandBlue300: palette.brandBlue300,
  brandBlue500: palette.brandBlue500,
  brandBlue600: palette.brandBlue600,
  brandBlue700: palette.brandBlue700,
  brandTeal400: palette.brandTeal400,
  accentPurple: palette.accentPurple,
  accentPink: palette.accentPink,
} as const;

const statusRamp = {
  successBg: palette.greenBg,
  successFg: palette.greenFg,
  warningBg: palette.yellowBg,
  warningFg: palette.yellowFg,
  dangerBg: palette.redBg,
  dangerFg: palette.redFg,
  infoBg: palette.blueBg,
  infoFg: palette.blueFg,
  neutralBg: palette.grayBg,
  neutralFg: palette.grayFg,
} as const;

const onDarkRamp = {
  splashBackground: palette.splashNavy,
  onDark: '#ffffff',
  onDarkMuted: 'rgba(255,255,255,0.55)',
} as const;

export const lightColors: ThemeColors = {
  background: palette.neutral50,
  foreground: palette.neutral900,
  card: palette.neutral0,
  cardForeground: palette.neutral900,
  popover: palette.neutral0,
  popoverForeground: palette.neutral900,
  primary: palette.brandBlue500,
  primaryForeground: palette.neutral0,
  secondary: palette.secondaryLight,
  secondaryForeground: palette.neutral900,
  muted: palette.neutral100,
  mutedForeground: palette.neutral500,
  accent: palette.secondaryLight,
  accentForeground: palette.neutral900,
  destructive: palette.destructiveLight,
  destructiveForeground: palette.neutral0,
  border: palette.neutral200,
  input: palette.neutral200,
  ring: palette.brandBlue500,
  ...brandRamp,
  ...statusRamp,
  ...onDarkRamp,
};

export const darkColors: ThemeColors = {
  background: palette.darkBackground,
  foreground: palette.darkForeground,
  card: palette.darkCard,
  cardForeground: palette.darkForeground,
  popover: palette.darkCard,
  popoverForeground: palette.darkForeground,
  primary: palette.darkPrimary,
  primaryForeground: palette.neutral0,
  secondary: palette.darkSecondary,
  secondaryForeground: palette.darkForeground,
  muted: palette.darkMuted,
  mutedForeground: palette.darkMutedForeground,
  accent: palette.darkSecondary,
  accentForeground: palette.darkForeground,
  destructive: palette.darkDestructive,
  destructiveForeground: palette.neutral0,
  border: palette.darkBorder,
  input: palette.darkBorder,
  ring: palette.darkPrimary,
  ...brandRamp,
  // Status backgrounds are tinted down so they read on a dark card.
  successBg: '#0d2b1a',
  successFg: '#4ade80',
  warningBg: '#2e2408',
  warningFg: '#fbbf24',
  dangerBg: '#320f10',
  dangerFg: '#fca5a5',
  infoBg: '#0b1e3a',
  infoFg: '#93c5fd',
  neutralBg: palette.darkMuted,
  neutralFg: palette.darkMutedForeground,
  ...onDarkRamp,
};

/* ── Gradients ───────────────────────────────────────────────────────────── */

export const lightGradients: ThemeGradients = {
  // linear-gradient(135deg, var(--brand-blue-500), var(--accent-purple) 60%, var(--accent-pink))
  primary: {
    colors: [palette.brandBlue500, palette.accentPurple, palette.accentPink],
    locations: [0, 0.6, 1],
    angle: 135,
  },
  // Fondo de Inicio, Ventas, el selector de empresa, el onboarding y el wizard.
  wash: {
    colors: [palette.washStart, palette.washMid, palette.washEnd],
    locations: [0, 0.55, 1],
    angle: 160,
  },
  splash: {
    colors: [palette.brandBlue500, palette.accentPurple, palette.splashNavy],
    locations: [0, 0.55, 1],
    angle: 150,
  },
  progress: {
    colors: [palette.brandBlue500, palette.brandTeal400],
    angle: 90,
  },
  // 180° = de arriba abajo.
  productTile: {
    colors: [palette.productTileTop, palette.productTileBottom],
    angle: 180,
  },
};

export const darkGradients: ThemeGradients = {
  ...lightGradients,
  // Plano sobre el canvas oscuro: el tinte claro de la versión light dejaría el
  // texto de la tarjeta sin contraste.
  productTile: {
    colors: [palette.darkProductTile, palette.darkProductTile],
    angle: 180,
  },
  wash: {
    colors: [palette.darkWashStart, palette.darkWashMid, palette.darkWashEnd],
    locations: [0, 0.55, 1],
    // 135°: claro arriba-izquierda → oscuro abajo-derecha (CSS mide en
    // sentido horario desde "hacia arriba" — 90° apunta a la derecha, 180°
    // hacia abajo, así que la diagonal top-left→bottom-right cae a medio
    // camino entre esos dos, en 135°). Da el efecto mate con reflejo pedido.
    angle: 135,
  },
};

/* ── Scale tokens (scheme-independent) ───────────────────────────────────── */

/** `--space-*` from `tokens/spacing.css`. */
export const spacing: ThemeSpacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  '3xl': 28,
  '4xl': 32,
  '5xl': 40,
};

/** `--radius-*` — base 10px, same multipliers as the CSS. */
export const radius: ThemeRadius = {
  sm: 6, // radius * 0.6
  md: 8, // radius * 0.8
  lg: 10, // radius
  xl: 14, // radius * 1.4
  '2xl': 18, // radius * 1.8
  '3xl': 22, // radius * 2.2
  full: 9999,
};

/** `--text-*`, `--leading-*` and the DM Sans family from `tokens/typography.css`. */
export const typography: ThemeTypography = {
  fontFamily: {
    regular: 'DMSans_400Regular',
    medium: 'DMSans_500Medium',
    semibold: 'DMSans_600SemiBold',
    bold: 'DMSans_700Bold',
    extrabold: 'DMSans_800ExtraBold',
  },
  fontSize: {
    xs: 11,
    sm: 12,
    base: 13,
    md: 14,
    lg: 15,
    xl: 18,
    '2xl': 22,
    '3xl': 26,
  },
  lineHeight: {
    tight: 1.15,
    snug: 1.35,
    normal: 1.5,
  },
};

/**
 * `--shadow-*` translated to the RN shadow model. iOS reads shadow*, Android
 * reads elevation; both are set so the depth ranking survives either platform.
 */
export const lightShadows: ThemeShadows = {
  sm: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.05,
    shadowRadius: 2,
    elevation: 1,
  },
  md: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.1,
    shadowRadius: 10,
    elevation: 4,
  },
  lg: {
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.14,
    shadowRadius: 24,
    elevation: 10,
  },
  // 0 10px 24px -8px color-mix(in oklch, var(--accent-purple) 55%, transparent)
  primary: {
    shadowColor: palette.accentPurple,
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.55,
    shadowRadius: 16,
    elevation: 8,
  },
  // 0 14px 32px -8px color-mix(..., 55%) — success ring and selected cards
  primaryStrong: {
    shadowColor: palette.accentPurple,
    shadowOffset: { width: 0, height: 14 },
    shadowOpacity: 0.6,
    shadowRadius: 22,
    elevation: 12,
  },
};

/** Neutral shadows read as noise on a near-black canvas; only the glows stay. */
export const darkShadows: ThemeShadows = {
  ...lightShadows,
  sm: { ...lightShadows.sm, shadowOpacity: 0.3 },
  md: { ...lightShadows.md, shadowOpacity: 0.45 },
  lg: { ...lightShadows.lg, shadowOpacity: 0.6 },
};

/* ── Assembled default themes ────────────────────────────────────────────── */

export const lightTheme: OrbixTheme = {
  scheme: 'light',
  colors: lightColors,
  gradients: lightGradients,
  spacing,
  radius,
  shadows: lightShadows,
  typography,
};

export const darkTheme: OrbixTheme = {
  scheme: 'dark',
  colors: darkColors,
  gradients: darkGradients,
  spacing,
  radius,
  shadows: darkShadows,
  typography,
};

export const defaultThemes = { light: lightTheme, dark: darkTheme } as const;
