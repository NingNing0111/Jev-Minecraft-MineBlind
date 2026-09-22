// Mineflayer's player inventory uses protocol slots, not items() order.
function extractEquipmentSlots(bot) {
  const slots = bot.inventory?.slots || [];
  const item = index => {
    const value = slots[index];
    return value ? { name: value.name, count: value.count } : null;
  };
  return {
    selected: Number.isInteger(bot.quickbarSlot) && bot.quickbarSlot >= 0 && bot.quickbarSlot < 9 ? bot.quickbarSlot : null,
    hotbar: Array.from({ length: 9 }, (_, index) => item(36 + index)),
    armor: { head: item(5), chest: item(6), legs: item(7), feet: item(8) },
    offhand: item(45),
  };
}
module.exports = { extractEquipmentSlots };
