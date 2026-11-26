# Keeping a small service healthy

A service that answers requests all day rarely fails in a dramatic way. More often it slows down by a few
milliseconds a week until somebody notices that the dashboards have turned orange. This note walks through the habits
that keep a small service healthy, from the first measurement to the last cleanup, and gives short examples in three
languages along the way.

## Why measure first

Intuition about performance is wrong more often than people admit. A function that looks expensive may run twice a
day, and a harmless loop may run ten thousand times per request. The only reliable way to decide where to spend
effort is to measure, and to measure the thing the user actually feels. A latency percentile tells you more than an
average, because the average hides the slow requests that annoy people the most.

Start with three numbers: how many requests arrive each second, how long the median one takes, and how long the
slowest one in a hundred takes. Write them down before changing anything. When a later change claims to help, these
numbers are the referee, and a claim without them is only a hope.

### What to record

Recording everything is as useless as recording nothing. Pick a small set of signals and keep them cheap to collect.
The list below is a reasonable starting point for a service with one database and one cache.

1. Request volume and error rate, split by route.
   - Group routes by pattern, never by the raw address, or the count of series will explode.
   - Keep the error rate separate from the timeout rate, because they have different causes.
2. Latency at the median, the 95th and the 99th percentile.
   - Measure it at the edge, where the user waits, and again just inside the handler.
   - The gap between those two numbers is the time spent queuing and in the network.
3. Resource use of the process itself.
   - Memory in use after a collection, not before it.
   - Open connections and open files, since leaks show up there first.
4. Dependencies.
   - Time spent waiting for the database, the cache and any other service.
   - The hit rate of the cache, because a falling hit rate quietly becomes more database load.

## Reading the numbers

Numbers only help when they are compared against something. The most useful comparison is the same service a week
ago at the same hour, because daily rhythm is usually larger than any real change. The second most useful is the
service against its own budget: if the budget for a page is two hundred milliseconds, then every stage should know its
share of it.

The table below shows how a budget might be divided for a typical page that reads from a database and renders a
template. The figures are examples, not recommendations; the point is that every stage has a number and an owner.

| Stage             | Budget (ms) | Typical (ms) | Owner         | Notes                          |
| ----------------- | ----------- | ------------ | ------------- | ------------------------------ |
| Routing and auth  | 10          | 4            | platform team | Cached session lookups         |
| Database reads    | 80          | 52           | data team     | Two queries, one index each    |
| Business rules    | 30          | 11           | feature team  | Pure computation, no I/O       |
| Template render   | 50          | 38           | feature team  | Grows with the size of a list  |
| Serialisation     | 15          | 9            | platform team | Compression is done by a proxy |
| Slack for network | 15          | 12           | everyone      | Not under our direct control   |

When a stage goes over its budget, the first question is not how to make it faster but whether it changed. A deploy,
a larger table, a new customer with ten times the usual data: each of these moves a stage without anyone touching its
code. Look at what changed before looking at what is slow.

## A few small examples

Short code is easier to discuss than long prose, so here are three fragments that come up again and again. None of
them is clever; their value is that each one removes a common source of trouble.

### Timing a section in TypeScript

Wrap the section in a helper that records how long it took, and report the result even when the section throws. Without
the `finally` block, the slowest and most interesting calls are exactly the ones that never get recorded.

```ts
type Recorder = (name: string, ms: number) => void

export async function timed<T>(name: string, record: Recorder, work: () => Promise<T>): Promise<T> {
  const started = performance.now()
  try {
    return await work()
  } finally {
    record(name, performance.now() - started)
  }
}

const record: Recorder = (name, ms) => {
  console.log(`${name} took ${ms.toFixed(1)} ms`)
}

const user = await timed('load user', record, () => fetchUser(42))
console.log(user.displayName)
```

### Bounding concurrency in Go

An unbounded number of workers feels fast until the database runs out of connections. A buffered channel used as a
semaphore keeps the number of simultaneous calls at a level the dependency can bear, and it needs no extra library.

```go
package pool

import "sync"

// Each runs work for every item with at most limit calls in flight at once.
func Each[T any](items []T, limit int, work func(T)) {
	slots := make(chan struct{}, limit)
	var wg sync.WaitGroup
	for _, item := range items {
		slots <- struct{}{}
		wg.Add(1)
		go func(it T) {
			defer wg.Done()
			defer func() { <-slots }()
			work(it)
		}(item)
	}
	wg.Wait()
}
```

### Watching a log from the shell

When something looks wrong, the quickest check is often the log itself. This pipeline prints the routes that returned
an error in the last thousand lines, counted and sorted so that the worst offender is on top.

```sh
#!/bin/sh
# Usage: slow-routes.sh access.log
tail -n 1000 "$1" \
  | awk '$9 >= 500 { count[$7]++ }
         END { for (route in count) print count[route], route }' \
  | sort -rn \
  | head -n 10
```

## Habits that pay off

The best performance work is boring. It is a short checklist that someone runs every week, and a rule that every
change to a hot path comes with a before and an after. Teams that do this rarely need a heroic week of tuning, because
the small regressions are caught while they are still small.

Some habits are worth naming, because they are easy to skip when a deadline is close.

- Keep a baseline file in the repository, and update it in the same change as the code that moves it.
- Prefer removing work to speeding it up. The cheapest query is the one that never runs.
- Put a limit on everything that can grow: page sizes, queue lengths, retries and the time allowed for a call.
- Treat a cache as an optimisation that may disappear. The service must still be correct when it is empty.
- Make the slow path visible. A request that takes ten times the median should leave a trace that explains why.

### On caches

Caches deserve a paragraph of their own, because they are both the most effective and the most dangerous tool in this
list. A cache turns a slow call into a fast one, and in exchange it introduces a second copy of the truth. Every cache
needs an answer to three questions: how does a stale entry get replaced, what happens when many requests miss at the
same moment, and how will anyone know the hit rate has dropped?

The second question matters more than it seems. When a popular entry expires, every request that needs it goes to the
database at once, and the database, already busy, answers slowly, which keeps the entry missing for longer. The usual
cure is to let only one request rebuild the value while the others wait for it or briefly serve the old one.

## Cleaning up

Systems collect leftovers: flags that no one turns off, tables nobody reads, endpoints that only a long-gone client
called. Each leftover costs a little on every deploy and every outage, because someone has to work out whether it
matters. Set aside a regular hour to remove one of them, and write down what you removed. After a year the service is
noticeably smaller, and smaller services are easier to keep fast.

## Closing thoughts

None of this is glamorous. Measure the thing users feel, divide the budget among the stages, change one thing at a
time, and keep the evidence next to the code. When the numbers move the wrong way, look first at what changed, and only
then at what is slow. A service treated this way tends to stay healthy for years, and the dashboards stay green long
enough that nobody has to look at them.

A last practical suggestion: write down what you expect before you run an experiment. If you predict that a change will
cut the median in half and it cuts it by five percent, you have learned something about your mental model, and that is
often worth more than the change itself. Over time, the gap between expectation and result narrows, and the
conversations about where to spend effort become shorter and calmer.

Finally, share what you learn. A short note in the repository, with the numbers, the date and the change that moved
them, saves the next person an afternoon. Notes like these are the cheapest form of monitoring there is, and unlike a
dashboard they explain why.
