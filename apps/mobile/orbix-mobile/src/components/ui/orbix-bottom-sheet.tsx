/**
 * Themed wrapper over `@gorhom/bottom-sheet`.
 *
 * Centralises the backdrop, the handle and the safe-area padding so every sheet
 * in the app opens the same way, and so a tenant's radius/colour overrides
 * apply without touching call sites.
 *
 * Built on `BottomSheetModal`, not the plain `BottomSheet` — a picker like this
 * is transient (opened on demand, unmounted from the flow otherwise), and only
 * the Modal variant portals through `BottomSheetModalProvider` to the true
 * root. The plain component renders in place, so nesting it inside a
 * scrollable form clips it to the field's own row instead of overlaying the
 * screen. Exposes the same imperative `expand`/`close` shape as before so
 * `OrbixSelect` didn't need to change.
 */
import {
  BottomSheetBackdrop,
  BottomSheetModal,
  BottomSheetView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, type ReactNode } from 'react';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OrbixText } from '@/components/ui/orbix-text';
import { useTheme } from '@/hooks/use-theme';

export interface OrbixBottomSheetProps {
  title?: string;
  children: ReactNode;
  /** Snap points as percentages or pixels; defaults to content height. */
  snapPoints?: (string | number)[];
  onClose?: () => void;
  /**
   * Sheets that CONTAIN inputs need `interactive`, o el teclado tapa el campo
   * que se está escribiendo. Los que solo listan opciones no lo necesitan, y
   * por eso no es el valor por defecto: `interactive` reposiciona la hoja en
   * cada foco y en una lista larga eso se ve como un salto.
   */
  keyboardBehavior?: 'extend' | 'fillParent' | 'interactive';
}

/** Matches the subset of the plain `BottomSheet` ref that call sites use. */
export interface OrbixBottomSheetRef {
  expand: () => void;
  close: () => void;
}

export const OrbixBottomSheet = forwardRef<OrbixBottomSheetRef, OrbixBottomSheetProps>(
  function OrbixBottomSheet({ title, children, snapPoints, onClose, keyboardBehavior }, ref) {
    const theme = useTheme();
    const insets = useSafeAreaInsets();
    const modalRef = useRef<BottomSheetModal>(null);

    useImperativeHandle(ref, () => ({
      expand: () => modalRef.current?.present(),
      close: () => modalRef.current?.dismiss(),
    }));

    const resolvedSnapPoints = useMemo(() => snapPoints, [snapPoints]);

    const renderBackdrop = useCallback(
      (props: BottomSheetBackdropProps) => (
        <BottomSheetBackdrop
          {...props}
          appearsOnIndex={0}
          disappearsOnIndex={-1}
          opacity={0.45}
          pressBehavior="close"
        />
      ),
      [],
    );

    return (
      <BottomSheetModal
        ref={modalRef}
        snapPoints={resolvedSnapPoints}
        enableDynamicSizing={!resolvedSnapPoints}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        onDismiss={onClose}
        {...(keyboardBehavior ? { keyboardBehavior } : {})}
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        backgroundStyle={{
          backgroundColor: theme.colors.card,
          borderTopLeftRadius: theme.radius['3xl'],
          borderTopRightRadius: theme.radius['3xl'],
        }}
        handleIndicatorStyle={{ backgroundColor: theme.colors.border, width: 36, height: 4 }}
      >
        <BottomSheetView
          style={{
            paddingHorizontal: theme.spacing['2xl'],
            paddingBottom: insets.bottom + theme.spacing.xl,
            gap: theme.spacing.md,
          }}
        >
          {title ? (
            <OrbixText size="md" weight="semibold" accessibilityRole="header">
              {title}
            </OrbixText>
          ) : null}
          {children}
        </BottomSheetView>
      </BottomSheetModal>
    );
  },
);
