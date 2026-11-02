package store

import (
	"context"
	"errors"
	"testing"
	"time"
)

func TestContentSaveConcurrentEditors(t *testing.T) {
	for _, kind := range []string{"dataset", "chart", "dashboard"} {
		t.Run(kind, func(t *testing.T) {
			pool, scope, dataset, chart, board := contentValidationFixture(t)
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			start := make(chan struct{})
			type result struct {
				name string
				err  error
			}
			done := make(chan result, 2)
			for _, name := range []string{"First editor", "Second editor"} {
				go func() {
					<-start
					var err error
					if kind == "dataset" {
						draft := dataset
						draft.Name = name
						_, err = UpdateDatasetChecked(ctx, pool, scope, draft, func(current Dataset, _ []Chart, _ []Dashboard) error {
							if current.Revision != draft.Revision {
								return ErrRevisionConflict
							}
							return nil
						})
					} else if kind == "chart" {
						draft := chart
						draft.Name = name
						_, err = UpdateChart(ctx, pool, scope, draft)
					} else {
						draft := board
						draft.Name = name
						_, err = SaveDashboard(ctx, pool, scope, draft, []string{chart.ID})
					}
					done <- result{name, err}
				}()
			}
			close(start)
			winner, conflicts := "", 0
			for range 2 {
				got := <-done
				if errors.Is(got.err, ErrRevisionConflict) {
					conflicts++
				} else if got.err != nil {
					t.Fatal(got.err)
				} else {
					winner = got.name
				}
			}
			if winner == "" || conflicts != 1 {
				t.Fatalf("winner %q, conflicts %d", winner, conflicts)
			}
			var name string
			var revision int
			if kind == "dataset" {
				got, err := GetDataset(ctx, pool, scope, dataset.ID)
				if err != nil {
					t.Fatal(err)
				}
				name, revision = got.Name, got.Revision
			} else if kind == "chart" {
				got, err := GetChart(ctx, pool, scope, chart.ID)
				if err != nil {
					t.Fatal(err)
				}
				name, revision = got.Name, got.Revision
			} else {
				got, err := GetDashboard(ctx, pool, scope, board.ID)
				if err != nil {
					t.Fatal(err)
				}
				name, revision = got.Name, got.Revision
				// A stale write cannot erase the dashboard's reference rows.
				if _, err := SaveDashboard(ctx, pool, scope, board, nil); !errors.Is(err, ErrRevisionConflict) {
					t.Fatalf("stale removal: %v", err)
				}
				var count int
				if err := pool.QueryRow(ctx, `SELECT count(*) FROM dashboard_charts WHERE dashboard_id = $1`, board.ID).Scan(&count); err != nil || count != 1 {
					t.Fatalf("references: %d, %v", count, err)
				}
			}
			if name != winner || revision != 2 {
				t.Fatalf("saved %q revision %d, winner %q", name, revision, winner)
			}
		})
	}
}
