/**
 * WIS+ animated splash screen.
 *
 * Sequence:
 *   1. `WIS` (bold metallic white) fades in on deep matte charcoal, 450 ms.
 *   2. The Mercedes signal-amber `+` enters from off-screen right and snaps
 *      into place beside `WIS` with a high-velocity spring
 *      (damping 14 / stiffness 280), triggering a brief amber glow pulse.
 *   3. Once `/api/health` responds (and the choreography has had time to land),
 *      the whole screen fades out into the main app.
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Text,
  View,
  interpolate,
  spring,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withTiming,
} from 'react-native-reanimated';

import { api } from '@/api/client';
import { colors, motion, radius, spacing } from '@/theme/tokens';

const AnimView = Animated.createAnimatedComponent(View);
const AnimText = Animated.createAnimatedComponent(Text);

interface SplashScreenProps {
  /** Called exactly once when the splash has fully faded out. */
  onComplete: () => void;
}

export default function SplashScreen({ onComplete }: SplashScreenProps) {
  const [healthy, setHealthy] = useState(false);
  const completedRef = useRef(false);
  const mountedAtRef = useRef(Date.now());
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;

  // --- poll /api/health until the sidecar answers (or we give up) -----------
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const deadline = mountedAtRef.current + motion.splash.healthTimeoutMs;

    const poll = async (): Promise<void> => {
      try {
        await api.health();
        if (!cancelled) setHealthy(true);
      } catch {
        if (cancelled) return;
        if (Date.now() >= deadline) {
          // Backend never came up — still let the app open (it shows offline).
          setHealthy(true);
        } else {
          timer = window.setTimeout(poll, motion.splash.healthPollMs);
        }
      }
    };
    poll();

    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, []);

  // --- animation state -------------------------------------------------------
  const wisOpacity = useSharedValue(0);   // `WIS` fade-in: 0 -> 1 over 450 ms
  const plusX = useSharedValue(220);      // `+` translateX: 220 -> 0 (spring)
  const glow = useSharedValue(0);         // amber glow pulse on landing
  const exitOpacity = useSharedValue(1);  // whole-splash fade-out

  useEffect(() => {
    withTiming(
      wisOpacity,
      { toValue: 1, duration: motion.splash.wisFadeInMs, easing: Easing.out(Easing.cubic) },
      (finished) => {
        if (!finished) return;
        // Immediately after the wordmark lands, the `+` slams in from the right.
        spring(
          plusX,
          { toValue: 0, ...motion.splash.plusSpring },
          (state) => {
            if (!state.finished) return;
            withSequence(
              withTiming(glow, { toValue: 1, duration: motion.splash.glowPulseMs.up }),
              withTiming(glow, { toValue: 0, duration: motion.splash.glowPulseMs.down }),
            );
          },
        );
      },
    );
  }, []);

  // --- fade out once the backend is ready and the choreography has landed ----
  useEffect(() => {
    if (!healthy) return;
    const elapsed = Date.now() - mountedAtRef.current;
    const wait = Math.max(0, motion.splash.minVisibleMs - elapsed);
    const t = window.setTimeout(() => {
      withTiming(
        exitOpacity,
        { toValue: 0, duration: motion.splash.exitFadeMs, easing: Easing.in(Easing.quad) },
        (finished) => {
          if (finished && !completedRef.current) {
            completedRef.current = true;
            onCompleteRef.current();
          }
        },
      );
    }, wait);
    return () => window.clearTimeout(t);
  }, [healthy]);

  // --- animated styles ---------------------------------------------------------
  const wisStyle = useAnimatedStyle(() => ({ opacity: wisOpacity.value }));

  const plusStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: plusX.value }],
    textShadowRadius: 6 + glow.value * 28,
    textShadowOffset: { width: 0, height: 0 },
    textShadowColor: interpolate(
      glow.value,
      [0, 1],
      ['rgba(229, 169, 60, 0.35)', 'rgba(229, 169, 60, 0.95)'],
    ),
  }));

  const exitStyle = useAnimatedStyle(() => ({ opacity: exitOpacity.value }));

  return (
    <AnimView style={[styles.root, exitStyle]}>
      <View style={styles.stage}>
        <AnimText style={[styles.wordmark, wisStyle]}>WIS</AnimText>
        <AnimText style={[styles.plus, plusStyle]}>+</AnimText>
      </View>
    </AnimView>
  );
}

const styles = {
  root: {
    flex: 1,
    backgroundColor: colors.bgPrimary,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    overflow: 'hidden' as const,
  },
  stage: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    overflow: 'hidden' as const,
  },
  wordmark: {
    fontSize: 112,
    fontWeight: '800' as const,
    letterSpacing: 6,
    color: colors.textPrimary, // bold metallic white
    textShadowColor: 'rgba(240, 243, 246, 0.25)',
    textShadowRadius: 18,
    textShadowOffset: { width: 0, height: 0 },
  },
  plus: {
    fontSize: 124,
    fontWeight: '700' as const,
    lineHeight: 128,
    marginLeft: spacing.xs,
    color: colors.accentAmber, // Mercedes signal amber
  },
} satisfies Record<string, React.CSSProperties & object>;
