# (mots-clés normalisés, emoji) — le premier qui correspond au TITRE donne le plat principal
DISH = [
 (['milkshake','smoothie'],'🥤'),(['cocktail','mojito','spritz','sangria','punch','virgin','limonade','citronnade'],'🍹'),
 (['the ','tisane','infusion'],'🍵'),(['cafe','latte','cappuccino'],'☕'),(['chocolat chaud'],'☕'),(['jus '],'🧃'),
 (['wrap','burrito'],'🌯'),(['tacos','taco'],'🌮'),(['pizza'],'🍕'),(['burger','hamburger'],'🍔'),(['hot dog','hot-dog'],'🌭'),
 (['panini','sandwich','croque','toast','tartine','bruschetta'],'🥪'),(['samoussa','samosa','gyoza','ravioli','dumpling','momo','empanada','chausson','brick','nem','rouleau'],'🥟'),
 (['brochette','kebab','yakitori','satay','souvlaki'],'🍢'),(['omelette','tortilla','frittata','oeuf','oeufs','shakshuka'],'🍳'),
 (['soupe','veloute','potage','bouillon','chorba','harira','gaspacho','minestrone','goulash','borsch'],'🥣'),(['salade','taboule','coleslaw'],'🥗'),
 (['curry','dahl','dal ','tajine','tagine','ragout','mijote','cocotte','daube','bourguignon','blanquette','pot-au-feu','chili','stew','paprikash','sarmale','cassoulet'],'🍲'),
 (['pates','spaghetti','lasagne','tagliatelle','penne','macaroni','nouilles','ramen','pad thai','gnocchi'],'🍝'),(['risotto','paella','riz','pilaf','biryani','sushi','onigiri'],'🍚'),
 (['couscous','semoule','boulgour'],'🍛'),(['quiche','tarte salee','tourte','pastilla','feuillete','pie'],'🥧'),
 (['crepe','pancake','gaufre','blini'],'🥞'),(['gateau','cake','fondant','brownie','cheesecake','tiramisu','baklava','beignet','flan','clafoutis','muffin','cookie','biscuit','madeleine','strudel','dessert','tarte'],'🍰'),
 (['glace','sorbet'],'🍨'),(['mousse','creme','pudding','riz au lait'],'🍮'),(['chicken','poulet','volaille','dinde','canard','aile','cuisse'],'🍗'),
 (['boeuf','steak','agneau','veau','porc','cote','viande','boulette','kefta','saucisse','chorizo','merguez','jambon','kofta','albondiga','foie gras','sobrassada'],'🥩'),
 (['crevette','gambas','scampi'],'🍤'),(['poisson','saumon','thon','cabillaud','morue','sardine','truite','dorade','colin','merlu','bacalao','sole','limande','hareng','haring','boquerone','anchois'],'🐟'),
 (['moule','fruits de mer','calamar','poulpe'],'🦪'),(['frite','pomme de terre','patate','gratin','puree','rosti'],'🥔'),
 (['pain','brioche','focaccia','naan','pita','bagel','baguette'],'🍞'),(['fromage','fondue','raclette','camembert'],'🧀'),(['tomate','pa amb','pan con'],'🍅'),(['pimiento','padron'],'🌶️'),(['vin ','vin de'],'🍷'),(['gilda','canape','tapas','pincho'],'🍢'),(['tzatziki'],'🫙'),(['olio'],'🫒'),(['sarmi','dolma','feuille de vigne'],'🍃'),(['astuce','guide','technique'],'👨‍🍳'),(['yaourt'],'🥛'),(['galette','injera'],'🫓'),(['polenta','mamaliga'],'🌽'),
 (['houmous','hummus','tartinade','dip','caviar','guacamole','tapenade','pate de','rillette','sauce','marinade','vinaigrette','pesto'],'🫙'),
 (['legume','legumes','ratatouille','aubergine','courgette','poivron','champignon','chou','brocoli','haricot'],'🥦'),
]
ING = [ # ingrédients d'accompagnement (petites icônes)
 ('oeuf','🥚'),('tomate','🍅'),('fromage','🧀'),('mozzarella','🧀'),('parmesan','🧀'),('feta','🧀'),('poulet','🍗'),('boeuf','🥩'),('jambon','🥓'),('lardon','🥓'),('bacon','🥓'),
 ('saumon','🐟'),('thon','🐟'),('crevette','🍤'),('avocat','🥑'),('citron','🍋'),('citron vert','🍋'),('orange','🍊'),('fraise','🍓'),('framboise','🍓'),('banane','🍌'),('pomme','🍎'),('poire','🍐'),('mangue','🥭'),('ananas','🍍'),('cerise','🍒'),('peche','🍑'),('raisin','🍇'),('melon','🍈'),('pasteque','🍉'),('noix de coco','🥥'),('kiwi','🥝'),('myrtille','🫐'),
 ('chocolat','🍫'),('miel','🍯'),('lait','🥛'),('beurre','🧈'),('pain','🍞'),('riz','🍚'),('pates','🍝'),('pomme de terre','🥔'),('carotte','🥕'),('oignon','🧅'),('ail','🧄'),('poivron','🫑'),('piment','🌶️'),('concombre','🥒'),('aubergine','🍆'),('courgette','🥒'),('brocoli','🥦'),('champignon','🍄'),('mais','🌽'),('salade','🥬'),('epinard','🥬'),('chou','🥬'),
 ('menthe','🌿'),('basilic','🌿'),('persil','🌿'),('coriandre','🌿'),('herbe','🌿'),('olive','🫒'),('cacahuete','🥜'),('noix','🌰'),('amande','🌰'),('glacon','🧊'),('farine','🌾'),('sucre','🍬'),('sel','🧂'),
]
