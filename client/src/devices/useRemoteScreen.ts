import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { ScreenFrame } from '@swiftnest/api';

type Point = { x: number; y: number };
type Gesture = Point & { start: number; moved: boolean; multi: boolean; point?: Point; frame?: ScreenFrame };
export type SendInput = (tool: string, args: Record<string, unknown>, source?: ScreenFrame) => void;
function useScreenState(frame: ScreenFrame | undefined, control: string, send: SendInput) {
  const surface = useRef<HTMLDivElement>(null);
  const picture = useRef<HTMLImageElement>(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | undefined>(undefined);
  const gestureFrame = useRef<number | undefined>(undefined);
  const previous = useRef<(Point & { distance: number }) | undefined>(undefined);
  useEffect(
    () => () => {
      if (gestureFrame.current !== undefined) cancelAnimationFrame(gestureFrame.current);
    },
    [],
  );
  const point = (x: number, y: number) => {
    const rect = picture.current?.getBoundingClientRect();
    if (!rect || !frame || x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) return;
    return { x: ((x - rect.left) * frame.width) / rect.width, y: ((y - rect.top) * frame.height) / rect.height };
  };
  return { surface, picture, view, setView, pointers, gesture, gestureFrame, previous, point, frame, control, send };
}

type ScreenState = ReturnType<typeof useScreenState>;

function pointerDown(state: ScreenState, event: PointerEvent) {
  const { pointers, gesture, previous, point, frame } = state;
  event.currentTarget.setPointerCapture(event.pointerId);
  pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.current.size === 1)
    gesture.current = {
      x: event.clientX,
      y: event.clientY,
      start: Date.now(),
      moved: false,
      multi: false,
      point: point(event.clientX, event.clientY),
      frame,
    };
  if (pointers.current.size > 1) {
    if (gesture.current) gesture.current.multi = true;
    const [first, second] = [...pointers.current.values()];
    previous.current = {
      distance: Math.hypot(first!.x - second!.x, first!.y - second!.y),
      x: (first!.x + second!.x) / 2,
      y: (first!.y + second!.y) / 2,
    };
  }
}

function pointerMove(state: ScreenState, event: PointerEvent) {
  const { pointers, gesture, gestureFrame, previous, setView, control, send } = state;
  const last = pointers.current.get(event.pointerId);
  if (!last) return;
  pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (gesture.current && Math.hypot(event.clientX - gesture.current.x, event.clientY - gesture.current.y) > 8)
    gesture.current.moved = true;
  if (pointers.current.size >= 2) {
    if (gestureFrame.current !== undefined) return;
    gestureFrame.current = requestAnimationFrame(() => {
      gestureFrame.current = undefined;
      const values = [...pointers.current.values()];
      if (values.length < 2) return;
      const first = values[0]!;
      const second = values[1]!;
      const current = {
        distance: Math.hypot(first.x - second.x, first.y - second.y),
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
      };
      const prior = previous.current;
      if (prior && prior.distance > 8) {
        const ratio = current.distance / prior.distance;
        if (Math.abs(ratio - 1) > 0.015) setView((v) => ({ ...v, zoom: Math.max(1, Math.min(5, v.zoom * ratio)) }));
        else if (control === 'owner')
          send('input_scroll', { dx: (prior.x - current.x) * 2, dy: (prior.y - current.y) * 2 });
        else setView((v) => ({ ...v, x: v.x + current.x - prior.x, y: v.y + current.y - prior.y }));
      }
      previous.current = current;
    });
  } else if (control !== 'owner')
    setView((v) => ({ ...v, x: v.x + event.clientX - last.x, y: v.y + event.clientY - last.y }));
}

function pointerUp(state: ScreenState, event: PointerEvent) {
  const { pointers, gesture, previous, point, control, send } = state;
  pointers.current.delete(event.pointerId);
  const currentGesture = gesture.current;
  if (currentGesture && !currentGesture.multi && control === 'owner') {
    if (currentGesture.moved) {
      const to = point(event.clientX, event.clientY);
      if (currentGesture.point && to)
        send('input_drag', { ...currentGesture.point, toX: to.x, toY: to.y }, currentGesture.frame);
    } else if (currentGesture.point)
      send(
        'input_click',
        { ...currentGesture.point, button: Date.now() - currentGesture.start >= 500 ? 'right' : 'left' },
        currentGesture.frame,
      );
  }
  if (!pointers.current.size) {
    gesture.current = undefined;
    previous.current = undefined;
  }
}

export function useRemoteScreen(frame: ScreenFrame | undefined, control: string, send: SendInput) {
  const state = useScreenState(frame, control, send);
  const { pointers, gesture, previous, setView, surface, picture, view } = state;
  const down = (event: PointerEvent) => pointerDown(state, event);
  const move = (event: PointerEvent) => pointerMove(state, event);
  const up = (event: PointerEvent) => pointerUp(state, event);
  const cancel = () => {
    pointers.current.clear();
    gesture.current = undefined;
    previous.current = undefined;
  };
  const wheel = (event: { deltaX: number; deltaY: number }) => {
    if (control === 'owner') send('input_scroll', { dx: event.deltaX, dy: event.deltaY });
    else setView((v) => ({ ...v, zoom: Math.max(1, Math.min(5, v.zoom - event.deltaY / 500)) }));
  };
  return { surface, picture, view, down, move, up, cancel, wheel, reset: () => setView({ zoom: 1, x: 0, y: 0 }) };
}
