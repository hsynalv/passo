// Merkezi hata mesajları yönetimi
// Türkçe mesajlar (varsayılan)

const messages = {
    // Validation mesajları
    VALIDATION_ERROR: 'Validation hatası',
    INVALID_REQUEST_DATA: 'Geçersiz istek verisi',
    
    // Bot işlem mesajları
    BUY_BUTTON_FAILED_A: 'SATIN AL tıklanamadı (A hesabı)',
    BUY_BUTTON_FAILED_B: 'SATIN AL tıklanamadı (B hesabı)',
    CATEGORY_NOT_FOUND: 'Uygun kategori bulunamadı',
    SEAT_SELECTION_FAILED_A: 'Sürede koltuk seçimi/sepet doğrulaması yapılamadı (A hesabı)',
    SEAT_PICK_FAILED_B: 'B hesabı hedef koltuğu zamanında alamadı',
    REMOVE_FROM_CART_FAILED: 'A hesabı koltuğu sepetten kaldıramadı',
    
    // Rate limiting
    RATE_LIMIT_EXCEEDED: 'Çok fazla istek gönderildi',
    RATE_LIMIT_MESSAGE: 'Lütfen bir süre bekleyip tekrar deneyin',
    
    // Genel hatalar
    UNEXPECTED_ERROR: 'Beklenmeyen bir hata oluştu',
    BOT_ERROR: 'Bot işlemi sırasında hata oluştu',
    
    // Başarı mesajları
    BOT_STARTED: 'Bot başlatıldı',
    BOT_COMPLETED: 'Bot başarıyla tamamlandı',
    LOGIN_SUCCESS_A: 'A hesabı giriş yaptı',
    LOGIN_SUCCESS_B: 'B hesabı giriş yaptı',
    SEAT_SELECTED_A: 'A hesabı koltuk seçti',
    SEAT_GRABBED_B: 'B hesabı koltuğu yakaladı',
    REMOVED_FROM_CART: 'A hesabı koltuğu sepetten kaldırdı',
};

// Hata mesajı formatla
const formatError = (key, ...args) => {
    let message = messages[key] || key;
    
    // Args varsa mesaja ekle
    if (args.length > 0) {
        args.forEach((arg, index) => {
            message = message.replace(`{${index}}`, arg);
        });
    }
    
    return message;
};

// Başarı mesajı formatla
const formatSuccess = (key, ...args) => {
    return formatError(key, ...args);
};

module.exports = {
    messages,
    formatError,
    formatSuccess
};


