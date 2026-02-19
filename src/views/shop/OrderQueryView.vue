<template>
    <div class="query-box">
        <h2 class="query-title">订单查询</h2>
        <div class="query-form-row" style="margin-bottom: 0.75rem;">
            <input v-model="queryId" type="text" placeholder="请输入订单号 (如: SOS...)" class="input-field" style="flex-grow: 1;">
            <input
                v-model="phoneLast4"
                type="text"
                placeholder="手机号后四位"
                class="input-field"
                style="width: 9rem;"
                maxlength="4"
                inputmode="numeric"
            >
            <button @click="query" class="market-btn primary-action" style="padding: 0 1.5rem;">查询</button>
        </div>
        <p style="margin: 0 0 1.5rem 0; color: #9ca3af; font-size: 0.8rem;">
            为保护隐私，查询需同时验证下单手机号后四位
        </p>

        <div v-if="error" style="background: #fef2f2; padding: 1.5rem; border-radius: var(--radius-md); text-align: center; color: #dc2626;">
            <i class="fa fa-exclamation-circle" style="font-size: 1.5rem; margin-bottom: 0.5rem;"></i>
            <p>{{ error }}</p>
        </div>

        <div v-else-if="order" class="query-result">
            <div class="result-header">
                <span class="result-order-id">订单: {{ order.id }}</span>
                <span :style="statusStyle">{{ statusText }}</span>
            </div>
            <div class="result-body">
                <div style="width: 100%; text-align: left;">
                    <!-- 收件信息 -->
                    <div style="padding: 0.75rem; background: #f9fafb; border-radius: 8px; margin-bottom: 0.75rem; font-size: 0.875rem; color: #374151;">
                        <div style="margin-bottom: 0.35rem;">
                            <i class="fa fa-user" style="width: 1rem; color: #9ca3af;"></i>
                            <strong>{{ order.contact.name }}</strong>
                            <span style="margin-left: 0.75rem; color: #6b7280;">{{ order.contact.phone }}</span>
                        </div>
                        <div v-if="order.contact.email" style="margin-bottom: 0.35rem;">
                            <i class="fa fa-envelope" style="width: 1rem; color: #9ca3af;"></i>
                            <span style="color: #6b7280;">{{ order.contact.email }}</span>
                        </div>
                        <div>
                            <i class="fa fa-map-marker-alt" style="width: 1rem; color: #9ca3af;"></i>
                            <span style="color: #6b7280;">{{ order.contact.province }}{{ order.contact.city }}{{ order.contact.district }} {{ order.contact.addressDetail }}</span>
                        </div>
                    </div>

                    <!-- 商品明细 -->
                    <div v-for="item in order.items" :key="item.id" class="query-item-row">
                        <span class="query-item-name">{{ item.name }} x{{ item.quantity }}</span>
                        <span style="color: #6b7280;">&yen;{{ item.price * item.quantity }}</span>
                    </div>
                    <div class="query-total-row">
                        <span>合计（含运费）</span>
                        <span style="color: #dc2626;">&yen;{{ order.total }}</span>
                    </div>

                    <!-- 下单时间 -->
                    <div style="font-size: 0.8rem; color: #9ca3af; padding-top: 0.25rem;">
                        <i class="fa fa-clock"></i> 下单时间: {{ new Date(order.created_at).toLocaleString() }}
                    </div>

                    <!-- 物流信息 -->
                    <div v-if="order.status === 3 || order.status === 4" style="margin-top: 0.75rem; padding: 0.75rem; border-radius: 8px;" :style="order.trackingNo ? { background: '#eff6ff' } : { background: '#fefce8' }">
                        <p v-if="order.trackingNo" style="color: #1d4ed8; font-size: 0.875rem;">
                            <i class="fa fa-truck"></i>
                            {{ order.trackingCompany }}: {{ order.trackingNo }}
                        </p>
                        <p v-else style="color: #92400e; font-size: 0.875rem; line-height: 1.5;">
                            <i class="fa fa-info-circle"></i>
                            未回填快递单号，请在快递小程序中查询，如有问题可联系我们
                        </p>
                    </div>
                </div>
            </div>
        </div>

        <div v-else style="background: #f9fafb; padding: 1.5rem; border-radius: var(--radius-md); text-align: center; color: #9ca3af;">
            <i class="fa fa-search" style="font-size: 1.5rem; margin-bottom: 0.5rem;"></i>
            <p>请输入订单号查询发货状态</p>
        </div>
    </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { resolveApiPath } from '@/utils/runtimePaths'

const route = useRoute()
const queryId = ref('')
const phoneLast4 = ref('')
const order = ref(null)
const error = ref(null)

onMounted(() => {
    if (route.query.id) {
        queryId.value = route.query.id
    }
    if (route.query.phoneLast4) {
        phoneLast4.value = String(route.query.phoneLast4)
    }
    if (queryId.value && /^\d{4}$/.test(phoneLast4.value)) {
        query()
    }
})

const statusMap = {
    0: { text: '已取消', bg: '#fee2e2', color: '#dc2626' },
    1: { text: '待付款', bg: '#fef3c7', color: '#d97706' },
    2: { text: '待发货', bg: '#d1fae5', color: '#047857' },
    3: { text: '已发货', bg: '#dbeafe', color: '#1d4ed8' },
    4: { text: '已完成', bg: '#f3f4f6', color: '#374151' },
    5: { text: '待确认', bg: '#fce7f3', color: '#be185d' },
}

const statusText = computed(() => order.value ? (statusMap[order.value.status]?.text || '未知') : '')
const statusStyle = computed(() => {
    const s = order.value ? statusMap[order.value.status] : null
    return s ? { fontSize: '0.75rem', background: s.bg, color: s.color, padding: '2px 8px', borderRadius: '4px' } : {}
})

const query = async () => {
    if (!queryId.value.trim()) return
    if (!/^\d{4}$/.test(phoneLast4.value.trim())) {
        error.value = '请输入手机号后四位数字'
        order.value = null
        return
    }
    error.value = null
    order.value = null
    try {
        const params = new URLSearchParams({ phoneLast4: phoneLast4.value.trim() })
        const res = await fetch(`${resolveApiPath(`/orders/${queryId.value.trim()}`)}?${params.toString()}`)
        if (!res.ok) {
            const data = await res.json()
            error.value = data.error || '查询失败'
            return
        }
        order.value = await res.json()
    } catch (e) {
        error.value = '网络错误，请稍后重试'
    }
}
</script>

<style scoped>
.query-title {
    font-size: 1.5rem;
    font-weight: bold;
    text-align: center;
    color: #1f2937;
    margin-bottom: 2rem;
}

.query-form-row {
    display: flex;
    flex-direction: row;
    gap: 1rem;
}

.result-order-id {
    font-weight: bold;
    color: #374151;
}

.query-item-row {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid #f3f4f6;
}

.query-item-name {
    color: #374151;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 72%;
}

.query-total-row {
    display: flex;
    justify-content: space-between;
    padding: 0.75rem 0;
    font-weight: bold;
}

@media (max-width: 639px) {
    .query-title {
        margin-bottom: 1.25rem;
        font-size: 1.25rem;
    }
    .query-form-row {
        flex-direction: column;
        gap: 0.75rem;
    }
    .query-form-row .input-field {
        width: 100% !important;
    }
    .query-form-row .market-btn {
        width: 100%;
        padding: 0.625rem !important;
    }
    .query-item-row {
        flex-direction: column;
        gap: 0.2rem;
    }
    .query-item-name {
        max-width: 100%;
        white-space: normal;
        word-break: break-word;
    }
}
</style>
