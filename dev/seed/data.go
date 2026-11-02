package main

import (
	"fmt"
	"math"
	"math/rand/v2"
	"slices"
	"time"
)

// shanghai is the time zone of the sample data, UTC+8 all year. Times are
// kept as its wall clock in a time.Time in UTC, which is how a timestamp
// without a zone reads.
var shanghai = time.FixedZone("Asia/Shanghai", 8*60*60)

// orderGoal is how many orders there are in all, roughly.
const orderGoal = 20_000

var regions = []string{"华东", "华南", "华北", "西南", "华中"}

type city struct {
	name, province string
	region         int // its number in regions, from 1
	weight         float64
}

// cities are three levels deep with regions, for cascading filters, and
// many enough for a top N with the rest as others.
var cities = []city{
	{"上海", "上海", 1, 10}, {"南京", "江苏", 1, 5}, {"苏州", "江苏", 1, 5}, {"无锡", "江苏", 1, 3},
	{"杭州", "浙江", 1, 7}, {"宁波", "浙江", 1, 4}, {"温州", "浙江", 1, 3}, {"济南", "山东", 1, 3},
	{"青岛", "山东", 1, 4}, {"合肥", "安徽", 1, 3}, {"福州", "福建", 1, 3}, {"厦门", "福建", 1, 3},
	{"广州", "广东", 2, 8}, {"深圳", "广东", 2, 8}, {"东莞", "广东", 2, 3}, {"佛山", "广东", 2, 3},
	{"南宁", "广西", 2, 2}, {"海口", "海南", 2, 1},
	{"北京", "北京", 3, 9}, {"天津", "天津", 3, 4}, {"石家庄", "河北", 3, 2}, {"太原", "山西", 3, 2},
	{"呼和浩特", "内蒙古", 3, 1},
	{"成都", "四川", 4, 7}, {"重庆", "重庆", 4, 5}, {"昆明", "云南", 4, 2}, {"贵阳", "贵州", 4, 2},
	{"武汉", "湖北", 5, 5}, {"宜昌", "湖北", 5, 1}, {"长沙", "湖南", 5, 4}, {"郑州", "河南", 5, 4},
	{"洛阳", "河南", 5, 1}, {"南昌", "江西", 5, 2},
}

type product struct {
	name, category, subCategory string
	price, cost                 int64 // yuan
	weight                      float64
}

// products cost more than they sell for in two cases, which with discounts
// give orders a loss to shade.
var products = []product{
	{"星河 X5 手机", "数码", "手机", 3999, 3100, 2},
	{"星河 A3 手机", "数码", "手机", 1599, 1650, 3},
	{"静界降噪耳机", "数码", "耳机", 899, 420, 3},
	{"轻跑运动耳机", "数码", "耳机", 299, 150, 4},
	{"墨页阅读器", "数码", "平板", 699, 760, 2},
	{"星河 Pad 11", "数码", "平板", 2599, 2050, 2},
	{"65W 快充头", "数码", "配件", 129, 45, 6},
	{"磁吸充电宝", "数码", "配件", 199, 120, 5},
	{"空气炸锅", "家电", "厨房电器", 399, 260, 4},
	{"智能电饭煲", "家电", "厨房电器", 499, 330, 3},
	{"破壁料理机", "家电", "厨房电器", 699, 520, 2},
	{"扫地机器人", "家电", "清洁电器", 2299, 1700, 2},
	{"无线吸尘器", "家电", "清洁电器", 1299, 980, 2},
	{"声波电动牙刷", "家电", "个护电器", 199, 80, 5},
	{"高速吹风机", "家电", "个护电器", 599, 300, 3},
	{"纯棉 T 恤", "服饰", "男装", 79, 30, 8},
	{"防风夹克", "服饰", "男装", 399, 180, 3},
	{"真丝连衣裙", "服饰", "女装", 699, 320, 3},
	{"羊毛风衣", "服饰", "女装", 1299, 650, 2},
	{"缓震跑鞋", "服饰", "鞋靴", 599, 280, 4},
	{"帆布鞋", "服饰", "鞋靴", 159, 60, 5},
	{"每日坚果礼盒", "食品", "零食", 129, 85, 7},
	{"风干牛肉干", "食品", "零食", 89, 50, 6},
	{"精品咖啡豆", "食品", "饮品", 99, 45, 6},
	{"明前龙井", "食品", "饮品", 399, 210, 2},
	{"长篇小说精装版", "图书", "文学", 59, 32, 4},
	{"儿童绘本套装", "图书", "少儿", 129, 70, 4},
}

// hours weighs the hours of a day: quiet at night, busy late morning and
// in the evening.
var hours = []float64{
	0.4, 0.2, 0.1, 0.1, 0.1, 0.2, 0.5, 1.2, 2.0, 2.6, 3.2, 3.4,
	2.8, 2.4, 2.4, 2.6, 2.6, 2.4, 2.6, 3.4, 4.0, 4.2, 3.2, 1.6,
}

// festival is how much busier a shopping festival makes a day.
func festival(day time.Time) float64 {
	switch _, m, d := day.Date(); {
	case m == time.November && d == 11:
		return 3
	case m == time.November && (d == 10 || d == 12):
		return 1.6
	case m == time.June && d == 18:
		return 2.2
	case m == time.December && d == 12:
		return 1.5
	}
	return 1
}

// generate draws the sample data from the first day of the month 18 months
// before today, a date in Shanghai, up to yesterday. Starting on the first
// keeps a comparison with a year before from setting a whole month against a
// few days. The draws come from a fixed seed, so the data only depends on the
// day it is generated.
func generate(today time.Time) []table {
	r := rand.New(rand.NewPCG(2026, 1021))
	start := today.AddDate(0, -18, 0)
	first := time.Date(start.Year(), start.Month(), 1, 0, 0, 0, 0, time.UTC)
	days := int(today.Sub(first).Hours() / 24)

	weights := make([]float64, days)
	var total float64
	for i := range weights {
		day := first.AddDate(0, 0, i)
		w := (0.6 + 0.8*float64(i)/float64(days-1)) * festival(day)
		if wd := day.Weekday(); wd == time.Saturday || wd == time.Sunday {
			w *= 1.3
		}
		weights[i], total = w, total+w
	}

	monthOf := func(t time.Time) int { return (t.Year()-first.Year())*12 + int(t.Month()-first.Month()) }
	months := monthOf(today) + 1
	paid := make([][5]int64, months) // paid order amounts by month and region, in cents

	cityWeights := make([]float64, len(cities))
	for i, c := range cities {
		cityWeights[i] = c.weight
	}
	productWeights := make([]float64, len(products))
	for i, p := range products {
		productWeights[i] = p.weight
	}

	var orderRows, trafficRows [][]any
	for i, w := range weights {
		day := first.AddDate(0, 0, i)
		progress := float64(i) / float64(days-1)
		ats := make([]time.Time, int(math.Round(orderGoal*w/total*(0.85+0.3*r.Float64()))))
		for k := range ats {
			ats[k] = day.Add(time.Duration(pick(r, hours))*time.Hour + time.Duration(r.IntN(60))*time.Minute)
		}
		slices.SortFunc(ats, time.Time.Compare)

		var placed [2]int64 // orders on the app and on the web
		for _, at := range ats {
			ci := pick(r, cityWeights)
			var cityID any = int64(ci + 1)
			if r.Float64() < 0.02 {
				cityID = nil // unknown
			}
			pi := pick(r, productWeights)
			p := products[pi]

			// The app takes a growing share of orders.
			channel, app := "store", 0.4+0.2*progress
			switch x := r.Float64(); {
			case x < app:
				channel = "app"
				placed[0]++
			case x < app+(1-app)*0.62:
				channel = "web"
				placed[1]++
			}
			status := []string{"paid", "paid", "paid", "paid", "paid", "paid", "paid", "refunded", "cancelled"}[r.IntN(9)]
			user := fmt.Sprintf("u%04d", 1+int(math.Pow(r.Float64(), 2)*3000))
			quantity := 1 + int64(math.Pow(r.Float64(), 3)*5)
			discount := 1 - 0.2*math.Pow(r.Float64(), 2)
			if festival(day) > 1 {
				discount *= 0.88
			}
			amount := int64(math.Round(float64(quantity*p.price*100) * discount))
			var cost any = quantity * p.cost * 100
			if r.Float64() < 0.01 {
				cost = nil // not booked yet
			}

			region := cities[ci].region
			if status == "paid" {
				paid[monthOf(at)][region-1] += amount
			}
			orderRows = append(orderRows, []any{
				int64(len(orderRows) + 1), at, int64(region), cityID, int64(pi + 1),
				channel, status, user, quantity, amount, cost,
			})
		}

		// The online funnel, ending in the orders of the day.
		for c, channel := range []string{"app", "web"} {
			cartAdds := math.Round(float64(placed[c]) / (0.28 + 0.06*r.Float64()))
			views := math.Round(cartAdds / (0.18 + 0.05*r.Float64()))
			visits := math.Round(views / (0.55 + 0.1*r.Float64()))
			trafficRows = append(trafficRows, []any{day, channel, int64(visits), int64(views), int64(cartAdds), placed[c]})
		}
	}

	// Targets follow what was paid, give or take; the current month, not over
	// yet, aims a little above the last one.
	var targetRows [][]any
	for m := range months {
		month := time.Date(first.Year(), first.Month()+time.Month(m), 1, 0, 0, 0, 0, time.UTC)
		for region := range regions {
			base := paid[m][region]
			if m == months-1 && m > 0 {
				base = paid[m-1][region] * 105 / 100
			}
			yuan := math.Round(float64(base)/100*(0.92+0.2*r.Float64())/1000) * 1000
			targetRows = append(targetRows, []any{month, int64(region + 1), int64(yuan) * 100})
		}
	}

	var regionRows, cityRows, productRows [][]any
	for i, name := range regions {
		regionRows = append(regionRows, []any{int64(i + 1), name})
	}
	for i, c := range cities {
		cityRows = append(cityRows, []any{int64(i + 1), c.name, c.province, int64(c.region)})
	}
	for i, p := range products {
		productRows = append(productRows, []any{int64(i + 1), p.name, p.category, p.subCategory, p.price * 100, p.cost * 100})
	}

	return []table{
		{
			name: "regions", comment: "销售大区", key: []string{"id"}, rows: regionRows,
			columns: []column{
				{name: "id", kind: integer, comment: "大区编号"},
				{name: "name", kind: text, size: 20, comment: "大区名称"},
			},
		},
		{
			name: "cities", comment: "城市：大区下按省份划分", key: []string{"id"}, rows: cityRows,
			columns: []column{
				{name: "id", kind: integer, comment: "城市编号"},
				{name: "name", kind: text, size: 20, comment: "城市名称"},
				{name: "province", kind: text, size: 20, comment: "所属省份"},
				{name: "region_id", kind: integer, comment: "所属大区，对应 regions.id"},
			},
		},
		{
			name: "products", comment: "商品", key: []string{"id"}, rows: productRows,
			columns: []column{
				{name: "id", kind: integer, comment: "商品编号"},
				{name: "name", kind: text, size: 40, comment: "商品名称"},
				{name: "category", kind: text, size: 20, comment: "品类"},
				{name: "sub_category", kind: text, size: 20, comment: "子品类"},
				{name: "unit_price", kind: money, size: 10, comment: "标价（元）"},
				{name: "unit_cost", kind: money, size: 10, comment: "单件成本（元），个别商品高于标价"},
			},
		},
		{
			name: "orders", comment: "订单：每一行是一笔订单", key: []string{"id"}, sortKey: []string{"created_at"}, index: "created_at", rows: orderRows,
			columns: []column{
				{name: "id", kind: bigint, comment: "订单号"},
				{name: "created_at", kind: timestamp, comment: "下单时间（上海时间）"},
				{name: "region_id", kind: integer, comment: "所属大区，对应 regions.id"},
				{name: "city_id", kind: integer, null: true, comment: "收货城市，对应 cities.id；未知时为空"},
				{name: "product_id", kind: integer, comment: "商品，对应 products.id"},
				{name: "channel", kind: text, size: 20, comment: "下单渠道：app、web 或 store"},
				{name: "status", kind: text, size: 20, comment: "订单状态：paid、refunded 或 cancelled"},
				{name: "user_id", kind: text, size: 20, comment: "下单用户"},
				{name: "quantity", kind: integer, comment: "商品件数"},
				{name: "amount", kind: money, size: 12, comment: "订单金额（元），已扣除折扣"},
				{name: "cost", kind: money, size: 12, null: true, comment: "订单成本（元）；尚未入账时为空"},
			},
		},
		{
			name: "daily_traffic", comment: "每日流量：线上渠道每天的访问和转化", key: []string{"stat_date", "channel"}, rows: trafficRows,
			columns: []column{
				{name: "stat_date", kind: date, comment: "日期"},
				{name: "channel", kind: text, size: 20, comment: "渠道：app 或 web"},
				{name: "visits", kind: integer, comment: "访问次数"},
				{name: "product_views", kind: integer, comment: "商品浏览次数"},
				{name: "cart_adds", kind: integer, comment: "加入购物车次数"},
				{name: "orders_placed", kind: integer, comment: "下单数，与 orders 中当天该渠道的订单数一致"},
			},
		},
		{
			name: "monthly_targets", comment: "月度销售目标", key: []string{"month_start", "region_id"}, rows: targetRows,
			columns: []column{
				{name: "month_start", kind: date, comment: "月份（当月第一天）"},
				{name: "region_id", kind: integer, comment: "大区，对应 regions.id"},
				{name: "target_amount", kind: money, size: 14, comment: "销售目标（元），按已支付订单的金额考核"},
			},
		},
	}
}

// pick draws an index with chances in proportion to weights.
func pick(r *rand.Rand, weights []float64) int {
	var total float64
	for _, w := range weights {
		total += w
	}
	x := r.Float64() * total
	for i, w := range weights {
		if x < w {
			return i
		}
		x -= w
	}
	return len(weights) - 1
}
