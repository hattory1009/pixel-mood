import { createFileRoute } from "@tanstack/react-router";
import { PixelMood } from "@/components/pixel-mood";

export const Route = createFileRoute("/")({ component: PixelMood });
