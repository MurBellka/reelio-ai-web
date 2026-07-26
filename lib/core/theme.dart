import 'package:flutter/material.dart';

/// Премиальная тема Reelio AI: холодный светлый фон, глубокий фиолетовый,
/// лавандовые поверхности и лаймовый акцент. Поддерживает светлый и тёмный режим.
class AppColors {
  const AppColors._();

  static const Color deepPurple = Color(0xFF5B21B6);
  static const Color purple = Color(0xFF7C3AED);
  static const Color lavender = Color(0xFFEDE9FE);
  static const Color lavenderDeep = Color(0xFFDDD6FE);
  static const Color lime = Color(0xFFC4F82A);
  static const Color limeDark = Color(0xFF3F4D07);
  static const Color coolBackground = Color(0xFFF5F4FC);
  static const Color ink = Color(0xFF1B1533);

  // Тёмная палитра.
  static const Color darkBackground = Color(0xFF120E22);
  static const Color darkSurface = Color(0xFF1E1836);
  static const Color darkSurfaceHigh = Color(0xFF2A2350);
}

class AppRadius {
  const AppRadius._();
  static const double sm = 16;
  static const double md = 20;
  static const double lg = 24;
  static const double xl = 28;

  static BorderRadius get card => BorderRadius.circular(lg);
  static BorderRadius get sheet => BorderRadius.circular(xl);
}

class AppTheme {
  const AppTheme._();

  static ThemeData light() {
    const scheme = ColorScheme(
      brightness: Brightness.light,
      primary: AppColors.deepPurple,
      onPrimary: Colors.white,
      primaryContainer: AppColors.lavenderDeep,
      onPrimaryContainer: AppColors.deepPurple,
      secondary: AppColors.purple,
      onSecondary: Colors.white,
      secondaryContainer: AppColors.lavender,
      onSecondaryContainer: AppColors.deepPurple,
      tertiary: AppColors.lime,
      onTertiary: AppColors.limeDark,
      tertiaryContainer: AppColors.lime,
      onTertiaryContainer: AppColors.limeDark,
      error: Color(0xFFB3261E),
      onError: Colors.white,
      errorContainer: Color(0xFFF9DEDC),
      onErrorContainer: Color(0xFF410E0B),
      surface: Colors.white,
      onSurface: AppColors.ink,
      surfaceContainerLowest: Colors.white,
      surfaceContainerLow: Color(0xFFF7F5FE),
      surfaceContainer: AppColors.coolBackground,
      surfaceContainerHigh: Color(0xFFEFECFB),
      surfaceContainerHighest: AppColors.lavender,
      onSurfaceVariant: Color(0xFF5A5470),
      outline: Color(0xFFC9C3E0),
      outlineVariant: Color(0xFFE3DEF4),
      shadow: Color(0x33342A63),
      scrim: Colors.black54,
      inverseSurface: AppColors.ink,
      onInverseSurface: Colors.white,
      inversePrimary: AppColors.lavenderDeep,
    );
    return _base(
      scheme,
    ).copyWith(scaffoldBackgroundColor: AppColors.coolBackground);
  }

  static ThemeData dark() {
    const scheme = ColorScheme(
      brightness: Brightness.dark,
      primary: Color(0xFFC4B5FD),
      onPrimary: Color(0xFF2A1065),
      primaryContainer: Color(0xFF4C1D95),
      onPrimaryContainer: Color(0xFFEDE9FE),
      secondary: Color(0xFFCDBBFB),
      onSecondary: Color(0xFF2A1065),
      secondaryContainer: Color(0xFF3B2E66),
      onSecondaryContainer: AppColors.lavender,
      tertiary: AppColors.lime,
      onTertiary: AppColors.limeDark,
      tertiaryContainer: Color(0xFF4A5A0C),
      onTertiaryContainer: AppColors.lime,
      error: Color(0xFFF2B8B5),
      onError: Color(0xFF601410),
      errorContainer: Color(0xFF8C1D18),
      onErrorContainer: Color(0xFFF9DEDC),
      surface: AppColors.darkSurface,
      onSurface: Color(0xFFEDEAF7),
      surfaceContainerLowest: AppColors.darkBackground,
      surfaceContainerLow: Color(0xFF181330),
      surfaceContainer: AppColors.darkSurface,
      surfaceContainerHigh: AppColors.darkSurfaceHigh,
      surfaceContainerHighest: Color(0xFF332A5C),
      onSurfaceVariant: Color(0xFFB6AED6),
      outline: Color(0xFF544B7A),
      outlineVariant: Color(0xFF322A52),
      shadow: Colors.black,
      scrim: Colors.black87,
      inverseSurface: Color(0xFFEDEAF7),
      onInverseSurface: AppColors.ink,
      inversePrimary: AppColors.deepPurple,
    );
    return _base(
      scheme,
    ).copyWith(scaffoldBackgroundColor: AppColors.darkBackground);
  }

  static ThemeData _base(ColorScheme scheme) {
    final baseTextTheme = Typography.material2021(
      platform: TargetPlatform.iOS,
    ).black.apply(bodyColor: scheme.onSurface, displayColor: scheme.onSurface);

    final textTheme = baseTextTheme.copyWith(
      displayLarge: baseTextTheme.displayLarge?.copyWith(
        fontWeight: FontWeight.w800,
        letterSpacing: -1.0,
        height: 1.05,
      ),
      displaySmall: baseTextTheme.displaySmall?.copyWith(
        fontWeight: FontWeight.w800,
        letterSpacing: -0.5,
        height: 1.08,
      ),
      headlineMedium: baseTextTheme.headlineMedium?.copyWith(
        fontWeight: FontWeight.w700,
        letterSpacing: -0.3,
      ),
      headlineSmall: baseTextTheme.headlineSmall?.copyWith(
        fontWeight: FontWeight.w700,
      ),
      titleLarge: baseTextTheme.titleLarge?.copyWith(
        fontWeight: FontWeight.w700,
      ),
      titleMedium: baseTextTheme.titleMedium?.copyWith(
        fontWeight: FontWeight.w600,
      ),
      labelLarge: baseTextTheme.labelLarge?.copyWith(
        fontWeight: FontWeight.w700,
        letterSpacing: 0.1,
      ),
    );

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      textTheme: textTheme,
      splashFactory: InkSparkle.splashFactory,
      appBarTheme: AppBarTheme(
        backgroundColor: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        centerTitle: false,
        titleTextStyle: textTheme.titleLarge,
        foregroundColor: scheme.onSurface,
      ),
      cardTheme: CardThemeData(
        elevation: 0,
        color: scheme.surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(borderRadius: AppRadius.card),
        margin: EdgeInsets.zero,
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          minimumSize: const Size(64, 56),
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
          textStyle: textTheme.labelLarge,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.md),
          ),
        ),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          minimumSize: const Size(64, 56),
          padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 16),
          textStyle: textTheme.labelLarge,
          side: BorderSide(color: scheme.outline),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(AppRadius.md),
          ),
        ),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(
          minimumSize: const Size(48, 44),
          textStyle: textTheme.labelLarge,
        ),
      ),
      chipTheme: ChipThemeData(
        backgroundColor: scheme.surfaceContainerHigh,
        side: BorderSide.none,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.sm),
        ),
        labelStyle: textTheme.labelLarge?.copyWith(color: scheme.onSurface),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      ),
      sliderTheme: SliderThemeData(
        activeTrackColor: scheme.primary,
        inactiveTrackColor: scheme.surfaceContainerHighest,
        thumbColor: scheme.primary,
        overlayColor: scheme.primary.withValues(alpha: 0.12),
        trackHeight: 6,
      ),
      switchTheme: SwitchThemeData(
        thumbColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected)
              ? scheme.onPrimary
              : scheme.outline,
        ),
        trackColor: WidgetStateProperty.resolveWith(
          (states) => states.contains(WidgetState.selected)
              ? scheme.primary
              : scheme.surfaceContainerHighest,
        ),
      ),
      snackBarTheme: SnackBarThemeData(
        behavior: SnackBarBehavior.floating,
        backgroundColor: scheme.inverseSurface,
        contentTextStyle: textTheme.bodyMedium?.copyWith(
          color: scheme.onInverseSurface,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(AppRadius.sm),
        ),
      ),
      dialogTheme: DialogThemeData(
        shape: RoundedRectangleBorder(borderRadius: AppRadius.sheet),
        backgroundColor: scheme.surface,
      ),
      bottomSheetTheme: BottomSheetThemeData(
        backgroundColor: scheme.surface,
        surfaceTintColor: Colors.transparent,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.vertical(
            top: Radius.circular(AppRadius.xl),
          ),
        ),
      ),
    );
  }
}
