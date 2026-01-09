<template>
  <div class="payment-container" v-if="order">
    <div class="text-center" style="margin-bottom: 2rem;">
        <h2 style="font-size: 1.5rem; font-weight: bold; color: #1f2937; margin: 0 0 0.5rem 0;">订单已提交</h2>
        <p style="color: #666; margin: 0;">请尽快完成支付，订单将保留 24 小时</p>
    </div>
    <div class="payment-grid">
        <div class="order-info-col">
            <label style="font-size: 0.75rem; color: #666; text-transform: uppercase; margin-bottom: 0.25rem;">订单编号</label>
            <div class="flex-row items-center gap-2" style="margin-bottom: 1.5rem;">
                <span class="order-sn">{{ order.id }}</span>
                <button @click="copy(order.id)" style="font-size: 0.75rem; background: #dbeafe; color: #2563eb; border: none; padding: 2px 6px; border-radius: 4px; cursor: pointer;">复制</button>
            </div>
            <label style="font-size: 0.75rem; color: #666; text-transform: uppercase; margin-bottom: 0.25rem;">应付金额</label>
            <div style="font-size: 1.875rem; font-weight: bold; color: #1f2937; margin-bottom: 0.5rem;">¥{{ order.total }}</div>
            <div style="font-size: 0.75rem; color: #9ca3af; margin-top: auto;">* 请务必支付准确金额，多付金额将作为应援金归入团费</div>
        </div>
        <div class="qr-col">
            <div class="qr-placeholder">
                <div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;">
                    <i class="fa fa-qrcode" style="font-size: 4rem; color: #333; opacity: 0.8;"></i>
                </div>
            </div>
            <p style="font-size: 0.875rem; font-weight: bold; color: #374151; margin: 0;">扫码支付 (支付宝/微信)</p>
            <div style="margin-top: 0.75rem; font-size: 0.75rem; color: #4b5563;">
                请备注: <span class="remark-code">{{ order.id.split('-').pop() }}</span>
            </div>
        </div>
    </div>
    
    <div style="margin-bottom: 2rem;">
        <label style="display: block; font-size: 0.875rem; font-weight: bold; color: #374151; margin-bottom: 0.5rem;">支付确认（重要）</label>
        <div class="flex-row gap-2">
            <input type="text" class="input-field" placeholder="请填入支付交易单号后4位 (选填，方便核对)">
        </div>
        <p style="font-size: 0.75rem; color: #9ca3af; margin: 0.5rem 0 0 0;">管理员将在每晚 22:00 统一核对账单并更新状态</p>
    </div>

    <div class="flex-row justify-center gap-4" style="justify-content: center;">
        <button class="market-btn btn-ghost" style="padding: 0.5rem 1.5rem;" @click="$router.push('/contact')">遇到问题</button>
        <button class="market-btn btn-green" style="padding: 0.5rem 2rem;" @click="confirm">
            <i class="fa fa-check mr-2"></i> 我已完成支付
        </button>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useShopStore } from '@/stores/shopStore'

const store = useShopStore()
const router = useRouter()
const order = computed(() => store.state.currentOrder)

const copy = (text) => {
    navigator.clipboard.writeText(text)
    store.showNotification('已复制')
}

const confirm = async () => {
    await store.updateOrderStatus(order.value.id, 5) // 5 = 待确认
    store.clearCart()
    router.push('/success')
}
</script>