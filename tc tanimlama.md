sepet sayfasında silme butonunun olduğu yerde şu kırım var:

<td _ngcontent-ng-c574173005="" class="ng-star-inserted"><!----><!----><!----><div _ngcontent-ng-c574173005="" class="input-group input-group-sm ng-star-inserted"><input _ngcontent-ng-c574173005="" type="text" class="form-control ng-untouched ng-pristine ng-valid" placeholder="T.C. Kimlik No" maxlength="11"><div _ngcontent-ng-c574173005="" class="input-group-append"><button _ngcontent-ng-c574173005="" type="button" class="btn btn-outline-dark ms-1" disabled=""> Tanımla </button><button _ngcontent-ng-c574173005="" type="button" class="btn btn-outline-danger ms-1"> Sil </button></div></div><div _ngcontent-ng-c574173005="" class="row input-group-sm mt-1 ng-star-inserted"><div _ngcontent-ng-c574173005="" class="col-md-12 ng-star-inserted"><quick-checkbox _ngcontent-ng-c574173005="" _nghost-ng-c2078252221=""><div _ngcontent-ng-c2078252221="" class="checkboxline quick-checkbox"><div _ngcontent-ng-c2078252221="" class="squaredFour d-flex"><input _ngcontent-ng-c2078252221="" type="checkbox" id="checkassign-to-my-id0_0"><label _ngcontent-ng-c2078252221="" for="checkassign-to-my-id0_0" class="ng-star-inserted"><span _ngcontent-ng-c2078252221="" class="ml-1">Kendi T.C. Kimlik Numarama Tanımla</span></label><!----><!----></div></div></quick-checkbox></div><!----><div _ngcontent-ng-c574173005="" class="col-md-12"><quick-checkbox _ngcontent-ng-c574173005="" _nghost-ng-c2078252221=""><div _ngcontent-ng-c2078252221="" class="checkboxline quick-checkbox"><div _ngcontent-ng-c2078252221="" class="squaredFour d-flex"><input _ngcontent-ng-c2078252221="" type="checkbox" id="checknot-tc-citizen0_0"><label _ngcontent-ng-c2078252221="" for="checknot-tc-citizen0_0" class="ng-star-inserted"><span _ngcontent-ng-c2078252221="" class="ml-1">T.C. Vatandaşı Değil</span></label><!----><!----></div></div></quick-checkbox></div></div><div _ngcontent-ng-c574173005="" class="row ng-star-inserted"><div _ngcontent-ng-c574173005="" class="col-12"><!----><!----></div></div><!----><!----></td>


buradaki input alanına tc girdikten sonra tanımla butonuna basarak veya kendi tc kimlik numarama tanımla kısmına tıklayarak tanımlayabilirsiniz. 

daha sonra devam butonuna basılır:

<div _ngcontent-ng-c574173005="" class="d-flex flex-wrap mt-1 mt-md-0 mb-5 justify-content-between ng-star-inserted"><button _ngcontent-ng-c574173005="" type="button" class="btn btn-dark ms-1 me-1 ng-star-inserted" style="font-size: 0.65rem !important;">Koltuk Ekle </button><!----><button _ngcontent-ng-c574173005="" type="button" class="btn btn-dark clear-all" style="font-size: 0.65rem !important; margin-right: auto;">Tümünü Sil </button><!----><!----><!----><!----><!----><!----><button _ngcontent-ng-c574173005="" type="button" class="btn red-btn mt-1 ms-1 me-1 ng-star-inserted" style="font-size: 0.65rem !important; margin: 0 auto;">Devam </button><!----></div>



daha sonra şu sayfaya yönlendiriliyoruz:  https://www.passo.com.tr/tr/etkinlik/kocaelispor-besiktas-mac-bileti-passo/10888383/odeme

bir modal çıkıyor şu yazıyor: Bilet alım işleminizi “Kredi Kart İle Öde” butonuna basarak farklı bankaya ait kartınız ile gerçekleştirebilirsiniz. Passo Taraftar Kart’ınız ile ödeme yapmak için kartınıza para yükleme işleminizi www.passotaraftar.com.tr “Kartına Para Yükle” sekmesinden giriş yaparak gerçekleştirebilirsiniz.

tamam butonuna basılır ve fatura bilgileri kısmında tc kimlik numarası inputu girilir:

<div _ngcontent-ng-c2978102154="" class="col-12 col-lg-5"><quick-form _ngcontent-ng-c2978102154="" _nghost-ng-c4090353857=""><h4 _ngcontent-ng-c4090353857="" class="ng-star-inserted">Fatura Bilgileri</h4><!----><hr _ngcontent-ng-c4090353857="" class="ng-star-inserted"><!----><br _ngcontent-ng-c4090353857=""><!----><div _ngcontent-ng-c4090353857="" class="form"><!----><!----><!----><!----><!----><div _ngcontent-ng-c2978102154="" style="margin-top: 20px; margin-bottom: 20px;" class="ng-star-inserted"> Faturanız aşağıda vereceğiniz detaylara göre e-arşiv veya e-fatura olarak düzenlenecektir.Şirket adına fatura için gerekli muhasebe detaylarınızı vermenizi rica ederiz.</div><quick-checkbox _ngcontent-ng-c2978102154="" id="send-invoice-my-membership" style="margin-top: 10px;" _nghost-ng-c2078252221="" class="ng-star-inserted"><div _ngcontent-ng-c2078252221="" class="checkboxline quick-checkbox"><div _ngcontent-ng-c2078252221="" class="squaredFour d-flex"><input _ngcontent-ng-c2078252221="" type="checkbox" id="checksend-invoice-my-membership"><label _ngcontent-ng-c2078252221="" for="checksend-invoice-my-membership" class="ng-star-inserted"><span _ngcontent-ng-c2078252221="" class="ml-1">Faturayı kayıtlı bilgilerime istiyorum.</span></label><!----><!----></div></div></quick-checkbox><div _ngcontent-ng-c2978102154="" style="margin-top: 20px; margin-bottom: 20px;" class="ng-star-inserted"><label _ngcontent-ng-c2978102154="" class="form-check-inline"><input _ngcontent-ng-c2978102154="" type="radio" id="rbPersonal" name="rbGroupMembershipInfo" class="form-check-input ng-untouched ng-pristine ng-valid"> Kişi </label><label _ngcontent-ng-c2978102154="" class="form-check-inline"><input _ngcontent-ng-c2978102154="" type="radio" id="rbCompany" name="rbGroupMembershipInfo" class="form-check-input ng-untouched ng-pristine ng-valid"> Şirket </label></div><quick-input _ngcontent-ng-c2978102154="" allowedkey="number" type="text" pattern="^[1-9]{1}[0-9]{10}$" _nghost-ng-c935647324="" class="ng-untouched ng-star-inserted ng-dirty ng-valid" required=""><label _ngcontent-ng-c935647324="" class="quick-input-label text-start ng-star-inserted"> T.C. Kimlik No <span _ngcontent-ng-c935647324="" class="text-red ms-1 ng-star-inserted">*</span><!----></label><!----><div _ngcontent-ng-c935647324="" class="clearfix"></div><input _ngcontent-ng-c935647324="" class="form-control mb-2 quick-input ng-valid ng-star-inserted ng-dirty ng-touched" autocomplete="" type="text" placeholder="T.C. Kimlik No" maxlength="11"><!----><!----><!----><!----><!----></quick-input><!----><!----><!----><quick-checkbox _ngcontent-ng-c2978102154="" id="not-tc-citizen" _nghost-ng-c2078252221="" class="ng-star-inserted"><div _ngcontent-ng-c2078252221="" class="checkboxline quick-checkbox"><div _ngcontent-ng-c2078252221="" class="squaredFour d-flex"><input _ngcontent-ng-c2078252221="" type="checkbox" id="checknot-tc-citizen"><label _ngcontent-ng-c2078252221="" for="checknot-tc-citizen" class="ng-star-inserted"><span _ngcontent-ng-c2078252221="" class="ml-1">T.C. Vatandaşı Değil</span></label><!----><!----></div></div></quick-checkbox><!----><quick-input _ngcontent-ng-c2978102154="" type="text" _nghost-ng-c935647324="" class="ng-untouched ng-pristine ng-star-inserted ng-valid" required=""><label _ngcontent-ng-c935647324="" class="quick-input-label text-start ng-star-inserted"> Adınız <span _ngcontent-ng-c935647324="" class="text-red ms-1 ng-star-inserted">*</span><!----></label><!----><div _ngcontent-ng-c935647324="" class="clearfix"></div><input _ngcontent-ng-c935647324="" class="form-control mb-2 quick-input ng-untouched ng-pristine ng-valid ng-star-inserted" autocomplete="" type="text" placeholder="Adınız"><!----><!----><!----><!----><!----></quick-input><!----><quick-input _ngcontent-ng-c2978102154="" type="text" _nghost-ng-c935647324="" class="ng-untouched ng-pristine ng-star-inserted ng-valid" required=""><label _ngcontent-ng-c935647324="" class="quick-input-label text-start ng-star-inserted"> Soyadınız <span _ngcontent-ng-c935647324="" class="text-red ms-1 ng-star-inserted">*</span><!----></label><!----><div _ngcontent-ng-c935647324="" class="clearfix"></div><input _ngcontent-ng-c935647324="" class="form-control mb-2 quick-input ng-untouched ng-pristine ng-valid ng-star-inserted" autocomplete="" type="text" placeholder="Soyadınız"><!----><!----><!----><!----><!----></quick-input><!----><!----><quick-input _ngcontent-ng-c2978102154="" type="text" pattern="^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$" _nghost-ng-c935647324="" class="ng-star-inserted ng-untouched ng-pristine ng-valid" required=""><label _ngcontent-ng-c935647324="" class="quick-input-label text-start ng-star-inserted"> Fatura gönderimi için E-Posta <span _ngcontent-ng-c935647324="" class="text-red ms-1 ng-star-inserted">*</span><!----></label><!----><div _ngcontent-ng-c935647324="" class="clearfix"></div><input _ngcontent-ng-c935647324="" class="form-control mb-2 quick-input ng-untouched ng-pristine ng-valid ng-star-inserted" autocomplete="" type="text" placeholder="Fatura gönderimi için E-Posta"><!----><!----><!----><!----><!----></quick-input><!----><quick-select _ngcontent-ng-c2978102154="" value-selector="id" name-selector="name" _nghost-ng-c2598594273="" class="ng-star-inserted"><label _ngcontent-ng-c2598594273="" class="quick-select-label text-start ng-star-inserted"> Ülke <span _ngcontent-ng-c2598594273="" class="text-red ms-1 ng-star-inserted">*</span><!----></label><!----><ng-select _ngcontent-ng-c2598594273="" class="quick-select ng-select-clearable ng-select ng-select-single ng-untouched ng-pristine ng-star-inserted ng-valid" required=""><div class="ng-select-container ng-has-value"><div class="ng-value-container"><div class="ng-placeholder">Ülke</div><div class="ng-value ng-star-inserted"><!----><span aria-hidden="true" class="ng-value-icon left ng-star-inserted">×</span><span class="ng-value-label ng-star-inserted">ANGOLA</span><!----></div><!----><!----><!----><!----><div role="combobox" aria-haspopup="listbox" class="ng-input" aria-expanded="false"><input aria-autocomplete="list" type="text" autocorrect="off" autocapitalize="off" autocomplete="a045e1dde738" readonly=""></div></div><!----><span tabindex="0" class="ng-clear-wrapper ng-star-inserted" title="Clear all"><span aria-hidden="true" class="ng-clear">×</span></span><!----><span class="ng-arrow-wrapper"><span class="ng-arrow"></span></span></div><!----></ng-select><!----><!----></quick-select><quick-select _ngcontent-ng-c2978102154="" value-selector="id" name-selector="name" _nghost-ng-c2598594273="" class="ng-star-inserted"><label _ngcontent-ng-c2598594273="" class="quick-select-label text-start ng-star-inserted"> Şehir <span _ngcontent-ng-c2598594273="" class="text-red ms-1 ng-star-inserted">*</span><!----></label><!----><ng-select _ngcontent-ng-c2598594273="" class="quick-select ng-select-clearable ng-select ng-select-single ng-untouched ng-pristine ng-star-inserted ng-valid" required=""><div class="ng-select-container ng-has-value"><div class="ng-value-container"><div class="ng-placeholder">Şehir</div><div class="ng-value ng-star-inserted"><!----><span aria-hidden="true" class="ng-value-icon left ng-star-inserted">×</span><span class="ng-value-label ng-star-inserted">Cunene Province</span><!----></div><!----><!----><!----><!----><div role="combobox" aria-haspopup="listbox" class="ng-input" aria-expanded="false"><input aria-autocomplete="list" type="text" autocorrect="off" autocapitalize="off" autocomplete="aff3d3245da9" readonly=""></div></div><!----><span tabindex="0" class="ng-clear-wrapper ng-star-inserted" title="Clear all"><span aria-hidden="true" class="ng-clear">×</span></span><!----><span class="ng-arrow-wrapper"><span class="ng-arrow"></span></span></div><!----></ng-select><!----><!----></quick-select><!----><!----><!----><quick-input _ngcontent-ng-c2978102154="" _nghost-ng-c935647324="" class="ng-star-inserted ng-untouched ng-pristine ng-valid" required=""><label _ngcontent-ng-c935647324="" class="quick-input-label text-start ng-star-inserted"> Adres Detayı <span _ngcontent-ng-c935647324="" class="text-red ms-1 ng-star-inserted">*</span><!----></label><!----><div _ngcontent-ng-c935647324="" class="clearfix"></div><!----><textarea _ngcontent-ng-c935647324="" class="mb-2 quick-textarea ng-untouched ng-pristine ng-valid ng-star-inserted" placeholder="Adres Detayı"></textarea><!----><!----><!----></quick-input><!----><!----><!----><!----><!----><!----><div _ngcontent-ng-c4090353857="" class="d-flex justify-content-end margin-top-10 ng-star-inserted"><button _ngcontent-ng-c4090353857="" class="btn-default btn form-cancel-button"><!----></button><!----><button _ngcontent-ng-c4090353857="" type="button" class="black-btn ng-star-inserted" style="margin: 0;"><span _ngcontent-ng-c4090353857="" class="ms-1 ng-star-inserted">Devam</span><!----></button><!----></div><!----></div></quick-form></div>



karşımıza çıkan sözleşmeler kabul edilir

<div _ngcontent-ng-c2978102154="" class="col-12 col-lg-5"><quick-form _ngcontent-ng-c2978102154="" _nghost-ng-c4090353857=""><h4 _ngcontent-ng-c4090353857="" class="ng-star-inserted">Fatura Bilgileri</h4><!----><hr _ngcontent-ng-c4090353857="" class="ng-star-inserted"><!----><br _ngcontent-ng-c4090353857=""><!----><div _ngcontent-ng-c4090353857="" class="form"><!----><!----><!----><!----><!----><div _ngcontent-ng-c2978102154="" style="margin-top: 20px; margin-bottom: 20px;" class="ng-star-inserted"> Faturanız aşağıda vereceğiniz detaylara göre e-arşiv veya e-fatura olarak düzenlenecektir.Şirket adına fatura için gerekli muhasebe detaylarınızı vermenizi rica ederiz.</div><quick-checkbox _ngcontent-ng-c2978102154="" id="send-invoice-my-membership" style="margin-top: 10px;" _nghost-ng-c2078252221="" class="ng-star-inserted"><div _ngcontent-ng-c2078252221="" class="checkboxline quick-checkbox"><div _ngcontent-ng-c2078252221="" class="squaredFour d-flex"><input _ngcontent-ng-c2078252221="" type="checkbox" id="checksend-invoice-my-membership"><label _ngcontent-ng-c2078252221="" for="checksend-invoice-my-membership" class="ng-star-inserted"><span _ngcontent-ng-c2078252221="" class="ml-1">Faturayı kayıtlı bilgilerime istiyorum.</span></label><!----><!----></div></div></quick-checkbox><div _ngcontent-ng-c2978102154="" style="margin-top: 20px; margin-bottom: 20px;" class="ng-star-inserted"><label _ngcontent-ng-c2978102154="" class="form-check-inline"><input _ngcontent-ng-c2978102154="" type="radio" id="rbPersonal" name="rbGroupMembershipInfo" class="form-check-input ng-untouched ng-pristine ng-valid"> Kişi </label><label _ngcontent-ng-c2978102154="" class="form-check-inline"><input _ngcontent-ng-c2978102154="" type="radio" id="rbCompany" name="rbGroupMembershipInfo" class="form-check-input ng-untouched ng-pristine ng-valid"> Şirket </label></div><quick-input _ngcontent-ng-c2978102154="" allowedkey="number" type="text" pattern="^[1-9]{1}[0-9]{10}$" _nghost-ng-c935647324="" class="ng-untouched ng-star-inserted ng-dirty ng-valid" required=""><label _ngcontent-ng-c935647324="" class="quick-input-label text-start ng-star-inserted"> T.C. Kimlik No <span _ngcontent-ng-c935647324="" class="text-red ms-1 ng-star-inserted">*</span><!----></label><!----><div _ngcontent-ng-c935647324="" class="clearfix"></div><input _ngcontent-ng-c935647324="" class="form-control mb-2 quick-input ng-valid ng-star-inserted ng-dirty ng-touched" autocomplete="" type="text" placeholder="T.C. Kimlik No" maxlength="11"><!----><!----><!----><!----><!----></quick-input><!----><!----><!----><quick-checkbox _ngcontent-ng-c2978102154="" id="not-tc-citizen" _nghost-ng-c2078252221="" class="ng-star-inserted"><div _ngcontent-ng-c2078252221="" class="checkboxline quick-checkbox"><div _ngcontent-ng-c2078252221="" class="squaredFour d-flex"><input _ngcontent-ng-c2078252221="" type="checkbox" id="checknot-tc-citizen"><label _ngcontent-ng-c2078252221="" for="checknot-tc-citizen" class="ng-star-inserted"><span _ngcontent-ng-c2078252221="" class="ml-1">T.C. Vatandaşı Değil</span></label><!----><!----></div></div></quick-checkbox><!----><quick-input _ngcontent-ng-c2978102154="" type="text" _nghost-ng-c935647324="" class="ng-untouched ng-pristine ng-star-inserted ng-valid" required=""><label _ngcontent-ng-c935647324="" class="quick-input-label text-start ng-star-inserted"> Adınız <span _ngcontent-ng-c935647324="" class="text-red ms-1 ng-star-inserted">*</span><!----></label><!----><div _ngcontent-ng-c935647324="" class="clearfix"></div><input _ngcontent-ng-c935647324="" class="form-control mb-2 quick-input ng-untouched ng-pristine ng-valid ng-star-inserted" autocomplete="" type="text" placeholder="Adınız"><!----><!----><!----><!----><!----></quick-input><!----><quick-input _ngcontent-ng-c2978102154="" type="text" _nghost-ng-c935647324="" class="ng-untouched ng-pristine ng-star-inserted ng-valid" required=""><label _ngcontent-ng-c935647324="" class="quick-input-label text-start ng-star-inserted"> Soyadınız <span _ngcontent-ng-c935647324="" class="text-red ms-1 ng-star-inserted">*</span><!----></label><!----><div _ngcontent-ng-c935647324="" class="clearfix"></div><input _ngcontent-ng-c935647324="" class="form-control mb-2 quick-input ng-untouched ng-pristine ng-valid ng-star-inserted" autocomplete="" type="text" placeholder="Soyadınız"><!----><!----><!----><!----><!----></quick-input><!----><!----><quick-input _ngcontent-ng-c2978102154="" type="text" pattern="^[\w-\.]+@([\w-]+\.)+[\w-]{2,4}$" _nghost-ng-c935647324="" class="ng-star-inserted ng-untouched ng-pristine ng-valid" required=""><label _ngcontent-ng-c935647324="" class="quick-input-label text-start ng-star-inserted"> Fatura gönderimi için E-Posta <span _ngcontent-ng-c935647324="" class="text-red ms-1 ng-star-inserted">*</span><!----></label><!----><div _ngcontent-ng-c935647324="" class="clearfix"></div><input _ngcontent-ng-c935647324="" class="form-control mb-2 quick-input ng-untouched ng-pristine ng-valid ng-star-inserted" autocomplete="" type="text" placeholder="Fatura gönderimi için E-Posta"><!----><!----><!----><!----><!----></quick-input><!----><quick-select _ngcontent-ng-c2978102154="" value-selector="id" name-selector="name" _nghost-ng-c2598594273="" class="ng-star-inserted"><label _ngcontent-ng-c2598594273="" class="quick-select-label text-start ng-star-inserted"> Ülke <span _ngcontent-ng-c2598594273="" class="text-red ms-1 ng-star-inserted">*</span><!----></label><!----><ng-select _ngcontent-ng-c2598594273="" class="quick-select ng-select-clearable ng-select ng-select-single ng-untouched ng-pristine ng-star-inserted ng-valid" required=""><div class="ng-select-container ng-has-value"><div class="ng-value-container"><div class="ng-placeholder">Ülke</div><div class="ng-value ng-star-inserted"><!----><span aria-hidden="true" class="ng-value-icon left ng-star-inserted">×</span><span class="ng-value-label ng-star-inserted">ANGOLA</span><!----></div><!----><!----><!----><!----><div role="combobox" aria-haspopup="listbox" class="ng-input" aria-expanded="false"><input aria-autocomplete="list" type="text" autocorrect="off" autocapitalize="off" autocomplete="a045e1dde738" readonly=""></div></div><!----><span tabindex="0" class="ng-clear-wrapper ng-star-inserted" title="Clear all"><span aria-hidden="true" class="ng-clear">×</span></span><!----><span class="ng-arrow-wrapper"><span class="ng-arrow"></span></span></div><!----></ng-select><!----><!----></quick-select><quick-select _ngcontent-ng-c2978102154="" value-selector="id" name-selector="name" _nghost-ng-c2598594273="" class="ng-star-inserted"><label _ngcontent-ng-c2598594273="" class="quick-select-label text-start ng-star-inserted"> Şehir <span _ngcontent-ng-c2598594273="" class="text-red ms-1 ng-star-inserted">*</span><!----></label><!----><ng-select _ngcontent-ng-c2598594273="" class="quick-select ng-select-clearable ng-select ng-select-single ng-untouched ng-pristine ng-star-inserted ng-valid" required=""><div class="ng-select-container ng-has-value"><div class="ng-value-container"><div class="ng-placeholder">Şehir</div><div class="ng-value ng-star-inserted"><!----><span aria-hidden="true" class="ng-value-icon left ng-star-inserted">×</span><span class="ng-value-label ng-star-inserted">Cunene Province</span><!----></div><!----><!----><!----><!----><div role="combobox" aria-haspopup="listbox" class="ng-input" aria-expanded="false"><input aria-autocomplete="list" type="text" autocorrect="off" autocapitalize="off" autocomplete="aff3d3245da9" readonly=""></div></div><!----><span tabindex="0" class="ng-clear-wrapper ng-star-inserted" title="Clear all"><span aria-hidden="true" class="ng-clear">×</span></span><!----><span class="ng-arrow-wrapper"><span class="ng-arrow"></span></span></div><!----></ng-select><!----><!----></quick-select><!----><!----><!----><quick-input _ngcontent-ng-c2978102154="" _nghost-ng-c935647324="" class="ng-star-inserted ng-untouched ng-pristine ng-valid" required=""><label _ngcontent-ng-c935647324="" class="quick-input-label text-start ng-star-inserted"> Adres Detayı <span _ngcontent-ng-c935647324="" class="text-red ms-1 ng-star-inserted">*</span><!----></label><!----><div _ngcontent-ng-c935647324="" class="clearfix"></div><!----><textarea _ngcontent-ng-c935647324="" class="mb-2 quick-textarea ng-untouched ng-pristine ng-valid ng-star-inserted" placeholder="Adres Detayı"></textarea><!----><!----><!----></quick-input><!----><!----><!----><!----><!----><!----><div _ngcontent-ng-c4090353857="" class="d-flex justify-content-end margin-top-10 ng-star-inserted"><button _ngcontent-ng-c4090353857="" class="btn-default btn form-cancel-button"><!----></button><!----><button _ngcontent-ng-c4090353857="" type="button" class="black-btn ng-star-inserted" style="margin: 0;"><span _ngcontent-ng-c4090353857="" class="ms-1 ng-star-inserted">Devam</span><!----></button><!----></div><!----></div></quick-form></div>



en son iframe ile ödeme kısmına geçilir:

<iframe style="width: 100% !important; height:720px; margin-top: 1rem;" id="payment_nkolay_frame" allowfullscreen="">

<html lang="tr"><head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
    <meta name="author" content="Kadir Duman">
    <meta name="description" content="paynkolay - Sanal POS Ödeme Sayfası - Sanal ve Fiziki POS'unuzu hemen kullanmaya başlayın!">

    <meta http-equiv="Content-Security-Policy" content="default-src 'self'  'unsafe-inline';
      img-src data: https: http:    https://cdn.nkolayislem.com.tr/;
      connect-src  'self' data: https://www.google-analytics.com;
    style-src * data: https://www.gstatic.com/ https://fonts.googleapis.com 'self' 'unsafe-inline';
    font-src    'self' data: https://fonts.gstatic.com;">
    
   
     <meta http-equiv="pragma" content="no-cache">
    <meta name="robots" content="noindex">
    <link rel="stylesheet" href="/Vpos/css_new/bootstrap.min.css">
    <link rel="stylesheet" href="/Vpos/css/bootstrap-icons.css">
    <link rel="stylesheet" href="/Vpos/css_new/nkolaypos.css">
    <link rel="shortcut icon" type="image/x-icon" href="/Vpos/images/nkolay32x32.svg">
    <style>
        .full_modal-dialog {
            width: 98% !important;
            height: 92% !important;
            min-width: 98% !important;
            min-height: 92% !important;
            max-width: 98% !important;
            max-height: 92% !important;
            padding: 0 !important;
        }

        .full_modal-content {
            height: 99% !important;
            min-height: 99% !important;
            max-height: 99% !important;
        }

        .LockOn {
            display: block;
            visibility: visible;
            position: absolute;
            z-index: 999;
            top: 0px;
            left: 0px;
            width: 105%;
            height: 105%;
            background-color: white;
            vertical-align: central;
            text-align: center;
            padding-top: 20%;
            filter: alpha(opacity=75);
            opacity: 0.75;
            font-size: large;
            color: blue;
            font-style: italic;
            font-weight: 400;
            background-image: url("data:image/gif;base64,R0lGODlhyADMAOZ/AIHM/7zk/5DS//L6/+z3/6Tf/7Tk/tzz/4bT/un3/6ng/2nJ/v7+//D6/3bO/6vd//b7/+Dy/9Lv/7jm/+H1/+75/5bZ/9ry/+74/fb6/eL0//T5/KDY/9Lt/3zQ/8br/2bB/9fx/w2n/Mzq/wCY/5nW/z66//L4/K7i/+j1/Ei+/3PN/+v4/+b1/7Pg/9nw//n8/vT7/5/d/8zr//T6/vr9//z+//3+/8Dm//z9/s/u/8Pp/vn9/vX8/8Lp/3DF/4zR/9nv/0q9/W7L//X6/UCy//P4/J/Z/0q+/xyt/LPk/8/r/+n2/BCe/1PC//n9//D5//f8/8bo/9/y/43W/+b2/9Ds//v9/nnJ/yCl/+v2/Kbb/yuy/F/G/1bD//X7//n8/7zn//r8/svs/2C//4fU//H5/czt//j8//3+/uX2/2LH/zu4/d/0/zCr/9bu/8Pq//j8/rDf/9Tw/6/j//X7/lC4/7nj/9zx/4HS/+T1/1nD/fL5/Zjb//f7/f///yH/C05FVFNDQVBFMi4wAwEAAAAh/wtYTVAgRGF0YVhNUDw/eHBhY2tldCBiZWdpbj0i77u/IiBpZD0iVzVNME1wQ2VoaUh6cmVTek5UY3prYzlkIj8+IDx4OnhtcG1ldGEgeG1sbnM6eD0iYWRvYmU6bnM6bWV0YS8iIHg6eG1wdGs9IkFkb2JlIFhNUCBDb3JlIDUuMC1jMDYwIDYxLjEzNDc3NywgMjAxMC8wMi8xMi0xNzozMjowMCAgICAgICAgIj4gPHJkZjpSREYgeG1sbnM6cmRmPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5LzAyLzIyLXJkZi1zeW50YXgtbnMjIj4gPHJkZjpEZXNjcmlwdGlvbiByZGY6YWJvdXQ9IiIgeG1sbnM6eG1wTU09Imh0dHA6Ly9ucy5hZG9iZS5jb20veGFwLzEuMC9tbS8iIHhtbG5zOnN0UmVmPSJodHRwOi8vbnMuYWRvYmUuY29tL3hhcC8xLjAvc1R5cGUvUmVzb3VyY2VSZWYjIiB4bWxuczpkYz0iaHR0cDovL3B1cmwub3JnL2RjL2VsZW1lbnRzLzEuMS8iIHhtbG5zOnhtcD0iaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLyIgeG1wTU06T3JpZ2luYWxEb2N1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");
            background-repeat: no-repeat;
            background-attachment: fixed;
            background-position: center;
        }

        .custom-file-upload {
            background: #f7f7f7;
            padding: 8px;
            border: 1px solid #e3e3e3;
            border-radius: 5px;
            border: 1px solid #ccc;
            display: inline-block;
            padding: 6px 12px;
            cursor: pointer;
        }
    </style>
    <title>paynkolay - Sanal POS Ödeme Sayfası...</title>
    <script src="/Vpos/js_new/jquery-3.7.1.js"></script>
    <script src="/Vpos/js_new/bootstrap.min.js"></script>
    <script src="/Vpos/js_new/popper.min.js"></script>
    <script src="/Vpos/js/site.js?ver=26.01.01.004"></script>
    <script src="/Vpos/js_new/imask.min.js"></script>
    <script src="/Vpos/js_new/card.js?ver=26.01.01.004"></script>
 

</head>
<body>
    <input type="hidden" id="SetLogUrl" value="/VPos/Payment/SetLog">
    <main class="container form-signin mt-0 pt-0 shadow p-4 p-md-3">
        <link rel="stylesheet" href="/Vpos/css_new/card.css?ver=1">


<div id="index">

    <div id="indexHeader">
            <div class="text-center mb-3 mt-2"> <img class="img-fluid" src="data:image/jpeg;base64,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" height="60px" style="max-height:60px; max-width: 250px;"></div>

    </div>


<form action="/Vpos/Payment/Perform" id="perForm" method="post">        <input type="hidden" id="viewPages" name="viewPages" value="new">
        <input type="hidden" id="ci" name="ci" value="Kyt5V1BrKzhmbWlNM2FoZ2lMTUZNaExjTytUWTZseVZycTBQcjJYQk05S3RjUU5Jd2JURWFiSmVQUDloZzVuZw==">
        <input type="hidden" id="cardHolderIP" name="cardHolderIP">
        <input type="hidden" id="su" name="su" value="Szd5ckpneHY2WkxYZFhzS01hclhyWWl1a0F1dkVEcnNtTkJud012SG9SdXBydmVwbEpaYzFKYzEvL2NMZ1BVS3FXWE1ORXhUUldsYzE0Vk10Nm1MTkRyN01CanhWMHl0M0RUU2pQN01SV2c9">
        <input type="hidden" id="fu" name="fu" value="alZlNnJwamxqeVBaU1NzaXZSQ0JFZ3dva25oNXVpbXVuVGxrQ0t4N2R3NjIxTGRHUHlvS1N4OHk3L0R0ci9OakJvWldjQkRZZzExdWZMODN3Q2twSW5RaGFlOStRdEJmWTFoMDFyTTlwams9">
        <input type="hidden" id="pid" name="pid" value="00000000-0000-0000-0000-000000000000">
        <input type="hidden" id="cref" name="cref" value="OFd0UXU2T1A3TDA2ZjJMVWczOWU3cGxqdSs4Slg3Y2MwWG1la0J2YTc3K1VaNnF3ckQ3WWZ2NzhwbUVNMmo1cytrTGtCanVQd28wRFF5ajUrUFQyenYxZWRlUTlRQXg0emNBMzNEeVdWdS9uYWdZZ2dwN3E4MENDUHVDNFVmK3J6cHFHS3dvbDJRUXcxYUpYL3krcVp0ZjJBQjRwcVBkQU5RVi9hUG9MRUs5RXJnR0dNZHVkYUY5U24xVm55TmQwalNMWWd3MURwSDRHamlTM2VUeUxQTGNEblZCdkljMWo1ZFhKSTN5cG5EU09kYXpEQ2lRa3pzcGJVdGVzdnoxZjR1dE1OVk92Z0k2NEF5VGh4MnQyNlE9PQ==">
        <input type="hidden" id="amorj" name="amorj" value="VkRMR3lnZDZjTjBVVWdhYW1NcmxtT2Q1ZWZtcTltYytiZlNuR0hqbjZRZlEzZDZJMTlwbjBZalJkMUNKYnJPTw==">
        <input type="hidden" id="secorj" name="secorj" value="czU5MFhlK2NXYXhwNm9iUWFPUFNkSmR3ZHVXNFdpekU3M25heS9Ba1hvTmQ0UFpSQm8xUWdxREZEbjF5SWRmcw==">
        <input type="hidden" id="secrem" name="secrem" value="251">
        <input type="hidden" id="binen" name="binen" value="cVlaNC94WEdsQU1maTNkeVIwekZYZ3BXaWVudnhsZGVGLzdNZUQ4ZGE0UnBoZExqVnVMTy9kSkZKelN5czQ0Sw==">
        <input type="hidden" id="campen" name="campen" value="OFZUcjZoYWxFZFpydVREdGd1cjJmMVNFemRLSmdxUEZqckRUTDczWHdXNVFKQkdMSlF0aW5DUjN2eExhdmhORw==">
        <input type="hidden" id="namSur" name="namSur">
        <input type="hidden" id="usethreed" name="usethreed">
        <input type="hidden" id="hashData" name="hashData" value="N0rOx4zohKwHESSD0Y760vm+R0w=">
        <input type="hidden" id="agentCode" name="agentCode">
        <input type="hidden" id="detail" name="detail">
        <input type="hidden" id="environment" name="environment" value="ORTAKODEME">
        <input type="hidden" id="language" name="language" value="tr">
        <input type="hidden" id="transactionType" name="transactionType" value="TTNsbDlUK05rckVwcE9JWkh6dllMTEkrSHpkM0k4WXBVTmdqWE5kM1NVeFlMUUJCVXltU2JjTmNmaXpYdjloTg==">
        <input type="hidden" id="paymentRouter" name="paymentRouter" value="NONE">
        <input type="hidden" id="payByLinkOid" name="payByLinkOid" value="">
        <input type="hidden" id="getUrlAddress" name="getUrlAddress" value="88.248.21.106, 172.16.108.6">
        <input type="hidden" id="sx" name="sx" value="TjlTRkMzSThhMzE1WWtXWWFUUERzZ1VDY3loRUM4WW9zN2RONlE3QjFOK1UyNVFxa01TdkE0dEthQmpmSTNhY1ZnWDh5VkRHMTRxOE1tS0JCRmIvN1NXdDdoYXNjcGw5VDd5ZGdCcDhRWWxoYUcyTGJZNjZmMUFOa041MmVEZGxlMHJXMmNud3pLaHd6SE81Z1RZR0Vlby9ob3M1Y3RGYXRacVVLK3NMbDVNTnhqcWJTeGFsQ3VWdmdKaDh2akVyK2hTT0tGVHN6WHh1dVJqM3NNVXQrYzNHUjlzUENmSEhuNnNhSSsvTlFHWWZKdlZNN0U4OTc3dVZQai9JUXVmSw==">
        <input type="hidden" id="currencyCode" name="currencyCode" value="949">
        <input type="hidden" id="TransactionTrxId" name="TransactionTrxId" value="0fa30eab-c68f-4be4-a388-4e0f1516312c">
        <input type="hidden" id="CardStorageRegister" name="CardStorageRegister" value="false">
        <input type="hidden" id="customerKey" name="customerKey">
        <input type="hidden" id="createUser" name="createUser">
        <input type="hidden" id="origin" name="origin" value="UCtjSVA3S2diQ0lqcWtoM2duT0hickdTVjdHekFSOGJkNmFGN0dEM3hUSEZOZ0ZWMkRRVTdOTEpnSFJjcUNDK1NzcThPUFNaT0kxT1FmblJRdE5mVHc9PQ==">
        <input type="hidden" id="headers" name="headers" value="Z2F3cWxrVFJYejRZQWcvS0FsNkF2c0ovanZwTFMvVGdra1pRTWZ6M2Vva2xXWWJ0ckhCVE9jbGxKZW5YemdJeU8zVDMyamhQSlVETWVNU0hiMnNrRC9PN2IzN3NCa0JuY2QxT3BBMGFCMTlPZGNDME9ZU1ZXUkhENkE2SHFlbXVBNXlBMnJHUVRxdWlLbnN4OUROQ2lrNjZJK2VkVmhjQXhGeVFES0JTWUFucS9aeFY3aU5KNEhpb1E3S3NPRFUxWDhWQ09rNXk3amZBTlhkMzJ2UzZLUDY5MURrQ3FxNG9iK3ZjZGF4cEg3Wm1ZZEJuRFZTOFU2UklTTGhqK21XcjFiZzRlSmh6M0JvUVN5eXQ5blVoOGdOTndIU0ZNSFl3amdNeGJaRDZCcTEzSzA1V2xQcjNSZjhyQktUTk81K2ZUV1BLa3lzZGpLM05GbVRmeVdQTVJ4em9hbkV2bmZzNmdJOVNUb3FZdXBWQW44TXJacElkOWs3dm1TUUxUUnA4cmdZT1JHT0VwS3BIdWZoL0xiOE5XQjNXUHFSbHQzQ3NVRFhFcXpLb0dPYmRia2lTT3lzb3k3TVVONEd4YmZiS3d6UWRTamNRU21LMktxMmZ5dkZOQkNKREhqUzN5VUZpb3h3WTZDdnphaVlxODJ2c1BnY2tsUzZmUGR4UXdHVm1qUkRmcERoRGVYVm5VQkNreHpjT05xdEpETzBIdE9EWTNBQjJNaFB3R1JlUXducCtRZFF0Q1AyNFNqbDJUYzlvQlhrM0dMTy9oNGs2blJrcURnMml0WWNIdGlKVHdaWWVCQWN0ZFpQMmpxVDA3QWxCNGk0TlRHenUzWnkxbENGQmpsYVBIVnk3a0wwT1BKMHhBY2FCemhJVmtHZVNCQjlkd2hxVVd6SjJZY3B6QndoU2t3N2JrakRiV1NDSDNkR0NLeEh4VEdJU0hXclpRTVFrM2g0ZThaaExQUFFoZmcrV1htTTJaSEFjZy84MGQ0Y1dMT0J1TXFYMHRWcHNkUFJ4TE00UjV2L0xvaTN4WDFFUXhpSG1NcSt2ZkRrTThCNkVyNXhpcm0rUzBTczhqejBlOElMbzREWWFvQUdMV0NpRzRscGdFOGFJNE9qQ2xzSVk0bFJLcisxR0RmZWJ6dTRrV1VaYWJodjZ6WWY4bXlPL1M2Zm55aitNbTNvR0c1Ly9qRkZHbzVqakZPdXE2TG01ekU5eHE3RWFhNnJEdFU4TlZXVkNtN3hmTmRTeUlCeS8xNUIveG5wRkJ0NWZuakFDVHF4dytOR0dKTDl4a0FtZ0RPd0F1VXVBMFQ4cG81STlTQm1nZ0drUzc0Z2UxWVp2UVRWZGxGdWVxRHBuYU5wZkhJWVVONHA0R1F0Qjl3bGNQTTRNTVZFSFFudGZ6S3B6U2hBM25wZlFvTXd0ZmVJTFRTQnhaT3V5d2dId1RmQjZjYWZ3aktkNlRZbVphUkUyb1hLWVBMWHloTjV2YWtMMjlLTVA5aTlydE9ha0Vabm5vdU02VDh6Y0lTUGwvTExGVERMSUlWVjRhdGFEeG9uenFvUmk0cW5naC8ybWszZkJUZWFTNWVDbStUUHFxOEJBZnJNT3lwRzJuNTJZdDV2Q3VDa1ZUTGlIR0lkSDhBbFNpYjFXWEtOaDNzNW5vL3RVcU5xeWZYV1RpQng2TTUrbHRBaUN0WU5qbDU2Vk9vYmRqei9mTFQrelZ3alllZDJ0MVkzNEE1N0hwQ0ErUERVUEhJb1dRWlM2WHlFdzVtY0tWV2hOQlgwcWh3cTgrbWd2cFY2d3ppVFkxZlpqcVRtZkJRbDBsQT09">
        <input type="hidden" id="ecommerce" name="ecommerce">
        <input type="hidden" id="isc" name="isc">
        <input type="hidden" id="MerchantCustomerNo" name="MerchantCustomerNo" value="">
        <input type="hidden" id="pIsCommissionPaidByCustomer" name="pIsCommissionPaidByCustomer" value="dW5YZWhsSElDQUVDY3JZZ3RmWlkyWnUweWJMZzB2ZXBRWnkybzRidTVIZjB2NG9oS0taWXFTcW55SlhLMkRFdA==">
        <input type="hidden" id="PaymentMethodSubDesc" name="PaymentMethodSubDesc" value="eHdwZ1NOVTJJMHpGWTlFS3RmQjd6YWlHRHVla1BRM0tYMUF6a0pyMmtSOHhHYlVMQ2ZoR2dwOXNJWDFuV1JWbw==">
        <input type="hidden" id="recurringEndDate" name="recurringEndDate">
        <input type="hidden" id="recurringPeriod" name="recurringPeriod">
        <div class="input-group mb-3">
            <span class="input-group-text text-primary" style="min-height: 50px !important;" id="basic-addon12">
                <i class="bi bi-person fs-4"></i>
            </span>
            <input type="text" class="form-control" placeholder="Kart Üzerindeki Ad Soyad" id="name" name="name" autocomplete="cc-name" aria-describedby="basic-addon12">

        </div>
        <span id="validationwarningname" class="text-danger input-group"></span>
        <div class="input-group mb-3">
            <span class="input-group-text text-primary" style="min-height: 50px !important;" id="basic-addon1">
                <i class="bi bi-credit-card-2-front fs-4"></i>
            </span>  
            <svg id="ccicon" style="z-index:999" class="ccicon" width="750" height="471" viewBox="0 0 750 471" version="1.1" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
            </svg>
                <input type="text" inputmode="numeric" class="form-control" pattern="[0-9]*" placeholder="Kart Numarası" aria-label="number" id="number" name="number" autocomplete="cc-number" aria-describedby="basic-addon1">
        </div>
        <span id="validationwarningcard" class="text-danger input-group"></span>
        <div class="row g-1">
            <div class="col-8">
                <div class="input-group mb-3">
                    <span class="input-group-text text-primary" style="min-height: 50px !important;" id="basic-addon13">
                        <i class="bi bi-calendar3 fs-4"></i>
                    </span>
                    <select name="ay" id="ay" class="form-control" required="">
                        <option value="" disabled="" selected="">Ay</option>
                        <option value="01">01</option>
                        <option value="02">02</option>
                        <option value="03">03</option>
                        <option value="04">04</option>
                        <option value="05">05</option>
                        <option value="06">06</option>
                        <option value="07">07</option>
                        <option value="08">08</option>
                        <option value="09">09</option>
                        <option value="10">10</option>
                        <option value="11">11</option>
                        <option value="12">12</option>
                    </select>

                    <span class="input-group-text">/</span>
 
                    <select name="yil" id="yil" class="form-control" required="">
                        <option value="" disabled="" selected="">Yıl</option>
                                <option value="2026">2026</option>
                                <option value="2027">2027</option>
                                <option value="2028">2028</option>
                                <option value="2029">2029</option>
                                <option value="2030">2030</option>
                                <option value="2031">2031</option>
                                <option value="2032">2032</option>
                                <option value="2033">2033</option>
                                <option value="2034">2034</option>
                                <option value="2035">2035</option>
                                <option value="2036">2036</option>
                                <option value="2037">2037</option>

                    </select>
                </div>

            </div>
            <div class="col-4">

                <div class="input-group mb-3">
                    <span class="input-group-text text-primary" style="min-height: 50px !important;" id="basic-addon14">
                        <i class="bi bi-credit-card-2-back fs-4"></i>
                    </span>
                    <input type="text" inputmode="numeric" class="form-control" placeholder="CVV" id="cvv" name="cvv" autocomplete="cc-csc" aria-label="cvv" maxlength="4" aria-describedby="basic-addon14" spellcheck="false" mask="000">
                </div>

            </div>
            <span id="validationwarningcvv" class="text-danger input-group"></span>

            <div class="row g-2 mb-2 text-center" id="cardProgram">

                <div class="col-3">
                    <img src="/Vpos/img/mastercard.png" class="img-fluid" style="max-height:40px;">
                </div>

                <div class="col-3">
                    <img src="/Vpos/img/visa-yeni2.png" class="img-fluid" style="max-height:40px;">
                </div>

                <div class="col-3">
                    <img src="/Vpos/img/troy.png" class="img-fluid" style="max-height:40px;">
                </div>

                <div class="col-3">
                    <img src="/Vpos/img/american-express.png" class="img-fluid" style="max-height:40px;">
                </div>


            </div>

                <textarea style="display:none" class="form-control" id="exampleFormControlTextarea1" name="inputDescription" rows="3"></textarea>
                <input style="display:none" type="hidden" class="form-control" maxlength="255" name="inputNameSurname" value="">
        </div>
        <p id="taksitp">Taksit seçenekleri geçerli kart bilgilerini girdikten sonra görüntülenecektir.</p>
        <div class="row" id="taksit">
        </div>
        <div id="indexbutton">

            <button class="w-100 btn btn-lg btn-primary" type="button" onclick="validateForm();" name="paybuttontext" id="paybuttontext" title="Taksit Seçenekleri"> 2000,00 ₺ Öde</button>
            <div class="d-flex justify-content-center bd-highlight mt-3">
                <div class="p-2"><img src="/Vpos/img/advantage.svg" width="45" height="16"></div>
                <div class="p-2"><img src="/Vpos/img/axess.svg" width="35" height="16"></div>
                <div class="p-2"><img src="/Vpos/img/bonus.svg" width="61" height="16"></div>
                <div class="p-2"><img src="/Vpos/img/bankkart.svg" width="45" height="16"></div>
                <div class="p-2"><img src="/Vpos/img/qnb_gray.png" width="*" height="18"></div>
            </div>

            <div class="d-flex justify-content-center bd-highlight">
                <div class="p-2"><img src="/Vpos/img/maximum.svg" width="48" height="16"></div>
                <div class="p-2"><img src="/Vpos/img/paraf.svg" width="25" height="16"></div>
                <div class="p-2"><img src="/Vpos/img/world.svg" width="54" height="16"></div>
            </div>

            <div class="d-flex justify-content-center bd-highlight mb-3 mt-3">
                <small><a href="#" data-bs-toggle="modal" data-dismiss="modal" data-bs-target="#exampleModal" onclick="openModel('/VPos/Payment/GetAllInstalmentList','TjlTRkMzSThhMzE1WWtXWWFUUERzZ1VDY3loRUM4WW9zN2RONlE3QjFOK1UyNVFxa01TdkE0dEthQmpmSTNhY1ZnWDh5VkRHMTRxOE1tS0JCRmIvN1NXdDdoYXNjcGw5VDd5ZGdCcDhRWWxoYUcyTGJZNjZmMUFOa041MmVEZGxlMHJXMmNud3pLaHd6SE81Z1RZR0Vlby9ob3M1Y3RGYXRacVVLK3NMbDVNTnhqcWJTeGFsQ3VWdmdKaDh2akVyK2hTT0tGVHN6WHh1dVJqM3NNVXQrYzNHUjlzUENmSEhuNnNhSSsvTlFHWWZKdlZNN0U4OTc3dVZQai9JUXVmSw==','139265128','949','2000,00','false','NONE',0);" class="text-decoration-none mt-1"><span class="badge bg-primary">+ Taksit </span> seçenekleri ve kampanyaları göster</a></small>
            </div>

            <table id="counterdiv" style="width:100%; margin:auto; text-align:center; margin-top:7px;">
                <tbody><tr>
                    <td style="width:20%; text-align:right;">
                        <img id="clockimg" src="/Vpos/images/t10.gif" class="img-responsive" alt="Kalan süreniz" style="padding-top:2px;margin:auto;text-align:right;width:24px;">
                    </td>
                    <td style="width:80%; text-align:left; vertical-align:bottom;">
                        <span id="clock">Kalan süreniz:04:11</span>
                    </td>
                </tr>
            </tbody></table>

            <div class="d-flex text-center bd-highlight mb-5 mt-4">
                <span class="fontsmall">Bu ödeme işlemi, TCMB lisanslı Ödeme Kuruluşu  <a href="https://paynkolay.com.tr" class="text-decoration-none" target="_blank"><img class="img-fluid mb-1" src="/Vpos/img/nkolaylogo_90_blue.png" width="60" style="max-height: 25px;"></a>   altyapısı ile gerçekleşmektedir. </span>
            </div>
        </div>
<input name="__RequestVerificationToken" type="hidden" value="CfDJ8DgaujI1d35Gq32Pq-znWL716Dsclw_RQm_LQAdxql1aIrAl_NigX5mXbvYciMhV90fvGJUYCimD8ZamyjkP_vqKC7ULf0jJJtdraUeCvpPPPnlHUu-IKt0Ji-Ev87vmVb1QOVIKD4bs4jSDS5OcVEk"></form>

</div>




<!-- Modal -->

 

<div class="modal fade" id="exampleModal" tabindex="-1" aria-labelledby="exampleModalLabel">
    <div class="modal-dialog modal-xl">
        <div class="modal-content">
            <div class="modal-header">
                <h5 class="modal-title text-primary" id="exampleModalLabel">Taksit Seçenekleri</h5>
                <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
            </div>
            <div class="modal-body">
                <div class="table-responsive">
                    <table class="table table-striped fontsmall">
                        <thead>
                            <tr>
                                <th scope="col">Taksit</th>

                                <th scope="col"><img src="https://cdn.nkolayislem.com.tr/bank_logo_axess.svg" width="71" height="32"></th>
                                <th scope="col"><img src="https://cdn.nkolayislem.com.tr/bank_logo_bankkart.svg" width="71" height="32"></th>
                                <th scope="col"><img src="https://cdn.nkolayislem.com.tr/bank_logo_bonus.svg" width="71" height="32"></th>
                                <th scope="col"><img src="https://cdn.nkolayislem.com.tr/bank_logo_qnb.svg" width="50" height="32"></th>
                                <th scope="col"><img src="https://cdn.nkolayislem.com.tr/bank_logo_maximum.svg" width="71" height="32"></th>
                                <th scope="col"><img src="/Vpos/img/paraf.jpg" width="40" height="26"></th>
                                <th scope="col"><img src="/Vpos/img/saglam.png" width="72" height="26"></th>
                                <th scope="col"><img src="https://cdn.nkolayislem.com.tr/bank_logo_world.svg" width="71" height="32"></th>
                            </tr>
                        </thead>
                        <tbody id="listd">
                        </tbody>
                    </table>
                    <input type="hidden" id="amounts" name="amounts">
                    <script>
                        function oranChanged(val) {
                            var oranVal = document.getElementById(val.id).value;
                            var authAmount = parseFloat(100 / (1 - (oranVal.replace(",", ".")) / 100)).toFixed(2);
                            var oranVal = document.getElementById('tutar' + itemNo).value = numberFormatter(authAmount);//Müşteriden Çekilen Tutar
                        };
                        function numberFormatter(number) {
                            if (number !== typeof 'undefined') {
                                number = number.toString();
                                if (number.indexOf('.') == -1) {
                                    return number;
                                }
                                return number;
                            }
                        }
                        function numberFormattery(number) {
                            if (number !== typeof 'undefined') {
                                number = number.toString();
                                if (number.indexOf('.') == -1) {
                                    return number;
                                }
                                return number.substring(0, number.indexOf('.') + 3);
                            }
                        }
                    </script>
                </div>


                <h5 class="modal-title text-primary">+  Taksit Kampanyaları </h5>
                <hr>
                <div class="mx-2" id="plusList"> </div>

            </div>
            <div class="modal-footer">
                <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Kapat</button>

            </div>
        </div>
    </div>
</div>

<!-- Modal End-->

<script>
   
    var PAYMENT_ROUTER_PAY_BY_LINK = "PAY_BY_LINK";var pPA = 'NONE' == PAYMENT_ROUTER_PAY_BY_LINK; var pSAField = 'false' == 'true'; var pClientId = '139265128';var cardcampaign = "0"; var is = 12; var tlabel = 'Taksit'; var cbin = "nop";  var language = "tr";  var ljon;  var amountDisplay = '2000.00'; var aD1 = '2000,00'; var pUrl = '/VPos/Payment/GetAllInstalmentList';   var pDUrl = 'https://paynkolay.nkolayislem.com.tr/VPos';   var isC = "False" == "True";   var remainingSecond = 299;   var remainingSecondTreshold = 60;  var currencyCode = '949';   var currencyname = getCurrencySymbol(currencyCode);
    var deatilForce =  'false' == 'true' & '' == 'true';
    $.ajax({
        type: "POST",
        url: pUrl.replace("GetAllInstalmentList", "GetLanguage"),
        success: function (res) {
            ljon = res;
        }, error: Errorfunction
    });



</script>
<script src="/Vpos/js/modelinstalments.js?ver=26.01.01.004"></script>
<script>
    $(document).ready(function () {
        if (remainingSecond == 0) {
            $('#counterdiv').hide();
        }
        else {
            document.getElementById("clock").innerHTML = getLanguage("8") + new Date(remainingSecond * 1000).toISOString().substr(14, 5);
            countdownInterval = setInterval(function () { timer() }, 1000);
        }
        if (!IsNullOrEmty(document.referrer))
            $("#getUrlAddress").val(document.referrer.split('/')[2]);

        if (document.getElementById('coverScreen') != undefined)
            document.getElementById('coverScreen').hidden = true;


            $('#cvv').keydown(function (event) {
                preventKeysForCVC(event);
            });

        $('#cvv').on('paste', function (event) {
            if (!hasJustNumbers(event.originalEvent.clipboardData.getData('Text'))) {
                event.preventDefault();
            }
        });

        $('#number').keydown(function (event) {
            if (keyEventIsNumber(event)) {
                $("#validationwarningcard").html("");
            }
        });

        $('#number').keyup(function () {
            var foo = $(this).val().split(" ").join("");
            if (foo.length > 0) {
                foo = foo.match(new RegExp('.{1,4}', 'g')).join(" ");
            }
            $(this).val(foo);
        });

        $("#yil").blur(function () {
            var year = $("#yil").val();
            var d = new Date();
            var y = "" + d.getFullYear();
            if (year.length == 1) {
                $("#yil").val("" + y.substring(0, 3) + year);
            } else if (year.length == 2) {
                $("#yil").val("" + y.substring(0, 2) + year);
            } else if (year.length == 3) {
                $("#yil").val("" + y.substring(0, 1) + year);
            }
        });


        $("#number").change(function () {
            $("#taksit").html("<table class='table'><tr class='table-primary'><th class='table-primary'>" + getLanguage("9") + "</th></tr></table>");
        });

        var taksitprocess = true;

        function _onblur_number(amorjValue) {


            $("#taksit").html("<table class='table'><tr class='table-primary'><th class='table-primary'>" + getLanguage("9") + "</th></tr></table>");

            if (pPA && pSAField) {
                $("#validationwarninginputAmount").html("");

                if (IsNullOrEmty($("#inputAmount").val())) {
                    console.log("Tutar Giriniz.");
                    $("#validationwarninginputAmount").html("<h5>" + getLanguage("43") + "</h5>");
                    return;
                }
                if ($("#inputAmount").val() == "0") {
                    console.log("Tutar 0 olamaz");
                    $("#validationwarninginputAmount").html("<h5>" + getLanguage("41") + "</h5>");
                    return;
                }
            }

            var numberWithoutSpace = $("#number").val().replace(/\s/g, '');
            if (numberWithoutSpace.length > 12 && numberWithoutSpace.length < 20) {
                $("#validationwarningcard").html("");
                var errorExist = false;
                if (cardcampaign == "4" && (numberWithoutSpace.charAt(0) != "4")) {//visa
                    errorExist = true;
                    $("#validationwarningcard").html("<h5>" + getLanguage("14") + "</h5>");
                }

                if (cardcampaign == "5" && (numberWithoutSpace.charAt(0) != "5")) {//mastercard
                    errorExist = true;
                    $("#validationwarningcard").html("<h5>" + getLanguage("15") + "</h5>");
                }

                if (!(cbin == "nop")) {
                    var bins = cbin.split("|");
                    var binMatched = false;
                    for (var i = 0; i < bins.length; i++) {

                        if (numberWithoutSpace.substring(0, 8) == bins[i].trim()) {
                            binMatched = true;
                        } else if (numberWithoutSpace.substring(0, 6) == bins[i].trim()) {
                            binMatched = true;
                        }
                    }
                    if (!binMatched) {
                        errorExist = true;
                        $("#validationwarningcard").html("<h5 style='color:blue'>" + getLanguage("16") + "</h5>");
                    }
                }

                if (!errorExist & taksitprocess) {

                    taksitprocess = false;
                    $("#taksit").load("/VPos/Payment/Installments", { sx: $("#sx").val(), amorj: amorjValue, cardnumber: $("#number").val(), pid: '00000000-0000-0000-0000-000000000000', usethreed: $("#usethreed").val(), getUrlAddress: '', iscardvalid: true, transactionId: '', currencyCode: $("#currencyCode").val(), instalments: 0, language: language, foreignPaymenAllow: 'false', viewPage: 'new', TransactionTrxId: '0fa30eab-c68f-4be4-a388-4e0f1516312c', pIsCommissionPaidByCustomer: 'dW5YZWhsSElDQUVDY3JZZ3RmWlkyWnUweWJMZzB2ZXBRWnkybzRidTVIZjB2NG9oS0taWXFTcW55SlhLMkRFdA==', clientRefCode:'OFd0UXU2T1A3TDA2ZjJMVWczOWU3cGxqdSs4Slg3Y2MwWG1la0J2YTc3K1VaNnF3ckQ3WWZ2NzhwbUVNMmo1cytrTGtCanVQd28wRFF5ajUrUFQyenYxZWRlUTlRQXg0emNBMzNEeVdWdS9uYWdZZ2dwN3E4MENDUHVDNFVmK3J6cHFHS3dvbDJRUXcxYUpYL3krcVp0ZjJBQjRwcVBkQU5RVi9hUG9MRUs5RXJnR0dNZHVkYUY5U24xVm55TmQwalNMWWd3MURwSDRHamlTM2VUeUxQTGNEblZCdkljMWo1ZFhKSTN5cG5EU09kYXpEQ2lRa3pzcGJVdGVzdnoxZjR1dE1OVk92Z0k2NEF5VGh4MnQyNlE9PQ==', csCustomerKey:''}, function () {
                        taksitprocess = true;
                        if ($("#instalmentTd1").html() != undefined) { $("#instextid").show(); }
                        if ('false' == 'true') { $("#cardStorage").show(); }
                        $("#taksitp").html(getLanguage("57"));
                        if ($("#instalmentTd0").html() != undefined) { $("#paybuttontext").text($("#instalmentTd0")[0].children[0].innerHTML + getLanguage("7"));    if ($("#registerbtn") != undefined) { $("#registerbtn").prop("disabled", false);  } }
                        else {
                            if ($("#foreignPaymenAllowShow").html() == undefined) {
                                if (pPA) { $("#paybuttontext").text($("#inputAmount").val() +" "+ getCurrencySymbol(currencyCode) + " " + getLanguage("7")); } else { $("#paybuttontext").text("2000,00" +" " + getCurrencySymbol(currencyCode) + " " + getLanguage("7"));}
                                //$("#validationwarningcard").html("<h5>" + getLanguage("2") + "</h5>");
                            }
                        }
                    });
                }
            }
            else {
                $("#validationwarningcard").html("<h5>" + getLanguage("2") + "</h5>");
            }
        }

        $("#number").blur(function () {var amorjValue = $("#amorj").val(); _onblur_number(amorjValue);});
        if ($("#inputAmount")) {
            $("#inputAmount").change(function () {
                this.value = this.value.trim(); var countOfComma = [...this.value].filter(x => x === ',').length; if (countOfComma >= 2) { this.value = "0,00";}
                var keyValueModel = new Object(); keyValueModel.Key = "amountOrj"; keyValueModel.Value = this.value.replace(",", ".");
                $.ajax({ type: "POST", url: "/VPos/Payment/SetTempData",contentType: "application/json; charset=utf-8", data: JSON.stringify(keyValueModel),dataType: "json", success: function (response) { var amorjValue = response.Value; $("#amorj").val(amorjValue); _onblur_number(amorjValue); }, error: function (xhr, status, error) { console.log("xhr.status: " + xhr.status + " xhr.statusText: " + xhr.statusText + " status: " + status + " error: " + error);} });
            });
        }
    });

</script>


<script>
 
</script>

    </main>
    <div id="coverScreen" name="coverScreen" style="z-index:9999;" class="LockOn" hidden=""></div>
    



</body></html>

</iframe>


