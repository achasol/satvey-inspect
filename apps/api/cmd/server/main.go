package main

import (
	"log/slog"
	"os"
	"satvey/inspect/internal/app"
)

func main() {
	if err := app.Run(); err != nil {
		slog.Error("startup failed", "error", err)
		os.Exit(1)
	}
}
